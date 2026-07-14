import { existsSync } from "node:fs";
import { createHistory } from "../agent-optic.js";
import { resolvePrivacyConfig } from "../privacy/config.js";
import { redactString } from "../privacy/redact.js";
import type { SessionMeta } from "../types/session.js";
import type {
	CanonicalObservationProvider,
	ObservedSession,
	ObservationCapability,
	ObservationProviderResult,
	ObservationSourceCapability,
	SessionObservation,
	SessionObservationOptions,
} from "../types/observation.js";
import { toLocalDate } from "../utils/dates.js";
import { canonicalProvider, defaultProviderDir, isProvider } from "../utils/providers.js";

const DEFAULT_MAX_SESSIONS = 25;
const DEFAULT_MAX_PROMPTS = 5;
const DEFAULT_MAX_PROMPT_CHARS = 600;
const OBSERVATION_CAPABILITIES: ObservationCapability[] = [
	"provider-health",
	"bounded-sessions",
	"bounded-prompts",
	"privacy-profile",
	"source-capabilities",
];
const OBSERVATION_SOURCE_CAPABILITIES = new Set<ObservationSourceCapability>([
	"prompt",
	"transcript",
	"assistant-summary",
	"tool-calls",
	"files-referenced",
	"tokens",
	"cost",
	"model",
	"project",
	"timestamps",
	"lifecycle-event",
]);

type HistoryFactory = typeof createHistory;

interface SessionObservationDependencies {
	createHistory?: HistoryFactory;
	existsSync?: typeof existsSync;
	now?: () => number;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive integer`);
	return resolved;
}

function cleanPrompt(value: string, maxChars: number): string {
	const text = value.replace(/\s+/g, " ").trim();
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function sessionSortValue(session: SessionMeta): number {
	return Math.max(
		Number(session.lastFileActivity ?? 0),
		Number(session.timeRange?.end ?? 0),
		Number(session.timeRange?.start ?? 0),
	);
}

function isMissingStore(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const candidate = error as { code?: unknown; message?: unknown };
	return candidate.code === "ENOENT" || String(candidate.message ?? "").includes("ENOENT");
}

function safeErrorMessage(error: unknown, privacy: ReturnType<typeof resolvePrivacyConfig>): string {
	const message = error instanceof Error ? error.message : String(error);
	return redactString(message.replaceAll("\u0000", ""), privacy).slice(0, 500);
}

function boundedSession(
	provider: CanonicalObservationProvider,
	session: SessionMeta,
	maxPrompts: number,
	maxPromptChars: number,
): ObservedSession {
	const prompts = (Array.isArray(session.prompts) ? session.prompts : [])
		.slice(-maxPrompts)
		.map((prompt) => cleanPrompt(String(prompt), maxPromptChars));
	return {
		provider,
		sessionId: session.sessionId,
		project: session.project,
		projectName: session.projectName,
		prompts,
		promptTimestamps: Array.isArray(session.promptTimestamps)
			? session.promptTimestamps.slice(-maxPrompts)
			: [],
		timeRange: { start: session.timeRange.start, end: session.timeRange.end },
		lastFileActivity: session.lastFileActivity,
		lastPrompt: prompts.at(-1) ?? (session.lastPrompt ? cleanPrompt(String(session.lastPrompt), maxPromptChars) : undefined),
		lastPromptTimestamp: session.lastPromptTimestamp,
		userPromptCount: session.userPromptCount ?? session.prompts?.length ?? 0,
		activityKind: session.activityKind,
		lastMessageRole: session.lastMessageRole,
		lastMessageStopReason: session.lastMessageStopReason,
		lastMessageTimestamp: session.lastMessageTimestamp,
		dataCompleteness: session.dataCompleteness,
		sourceCapabilities: session.sourceCapabilities
			? session.sourceCapabilities.filter(
				(capability): capability is ObservationSourceCapability => OBSERVATION_SOURCE_CAPABILITIES.has(capability as ObservationSourceCapability),
			)
			: undefined,
		gitBranch: session.gitBranch,
		model: session.model,
		totalInputTokens: session.totalInputTokens,
		totalOutputTokens: session.totalOutputTokens,
		cacheCreationInputTokens: session.cacheCreationInputTokens,
		cacheReadInputTokens: session.cacheReadInputTokens,
		messageCount: session.messageCount,
		totalCost: session.totalCost,
	};
}

/**
 * Collect one bounded, deterministic observation across provider stores.
 * Agent-optic reports source facts and provider health; consumers own lifecycle judgment.
 */
export function collectSessionObservation(
	options: SessionObservationOptions,
): Promise<SessionObservation>;
export async function collectSessionObservation(
	options: SessionObservationOptions,
	dependencies: SessionObservationDependencies = {},
): Promise<SessionObservation> {
	if (!Array.isArray(options.providers) || options.providers.length === 0) {
		throw new Error("providers must contain at least one provider");
	}
	const invalidProviders = options.providers.filter((provider) => !isProvider(provider));
	if (invalidProviders.length > 0) throw new Error(`Unsupported provider: ${invalidProviders.join(", ")}`);
	const providers = [...new Set(options.providers.map((provider) => canonicalProvider(provider)))];
	const maxSessions = positiveInteger(options.maxSessions, DEFAULT_MAX_SESSIONS, "maxSessions");
	const maxPrompts = positiveInteger(options.maxPrompts, DEFAULT_MAX_PROMPTS, "maxPrompts");
	const maxPromptChars = positiveInteger(options.maxPromptChars, DEFAULT_MAX_PROMPT_CHARS, "maxPromptChars");
	const privacyProfile = options.privacy ?? "local";
	const privacy = resolvePrivacyConfig(privacyProfile);
	const makeHistory = dependencies.createHistory ?? createHistory;
	const pathExists = dependencies.existsSync ?? existsSync;
	const now = (dependencies.now ?? Date.now)();
	if (options.sinceMs !== undefined && (!Number.isInteger(options.sinceMs) || options.sinceMs < 1)) {
		throw new Error("sinceMs must be a positive integer");
	}
	if (options.sinceMs !== undefined && (options.date || options.from || options.to)) {
		throw new Error("sinceMs cannot be combined with date, from, or to");
	}
	const cutoff = options.sinceMs !== undefined ? now - options.sinceMs : undefined;
	const effectiveDate = options.date ?? (
		options.from === undefined && options.to === undefined && cutoff === undefined
			? toLocalDate(now)
			: undefined
	);
	const filter = {
		date: effectiveDate,
		from: options.from ?? (cutoff !== undefined ? toLocalDate(cutoff) : undefined),
		to: options.to,
		project: options.project,
	};

	const providerResults: ObservationProviderResult[] = [];
	const collected: ObservedSession[] = [];

	for (const provider of providers) {
		const providerDir = options.providerDirs?.[provider]
			?? (provider === "codex" ? options.providerDirs?.openai : undefined)
			?? defaultProviderDir(provider);
		if (!pathExists(providerDir)) {
			providerResults.push({
				provider,
				status: "absent",
				sessionCount: 0,
				error: { code: "PROVIDER_STORE_ABSENT", message: "Provider store is not present" },
			});
			continue;
		}

		try {
			const history = makeHistory({ provider, providerDir, privacy: privacyProfile });
			let sessions = await history.sessions.listWithMeta(filter);
			if (cutoff !== undefined) sessions = sessions.filter((session) => sessionSortValue(session) >= cutoff);
			providerResults.push({ provider, status: "available", sessionCount: sessions.length });
			for (const session of sessions) collected.push(boundedSession(provider, session, maxPrompts, maxPromptChars));
		} catch (error) {
			const absent = isMissingStore(error);
			providerResults.push({
				provider,
				status: absent ? "absent" : "error",
				sessionCount: 0,
				error: {
					code: absent ? "PROVIDER_STORE_ABSENT" : "PROVIDER_READ_FAILED",
					message: absent ? "Provider store is not present" : safeErrorMessage(error, privacy),
				},
			});
		}
	}

	const availableCount = providerResults.filter((result) => result.status === "available").length;
	const availability = availableCount === providerResults.length
		? "available"
		: availableCount > 0
			? "partial"
			: "unavailable";
	const sessions = collected
		.sort((a, b) => sessionSortValue(b) - sessionSortValue(a)
			|| (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0)
			|| (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
		.slice(0, maxSessions);

	return {
		schemaVersion: "agent-optic.observation/v1",
		generatedAt: new Date(now).toISOString(),
		availability,
		capabilities: [...OBSERVATION_CAPABILITIES],
		completeness: {
			observedSessions: collected.length,
			returnedSessions: sessions.length,
			truncated: collected.length > sessions.length,
		},
		query: {
			providers,
			privacy: privacyProfile,
			...(options.project ? { project: options.project } : {}),
			...(effectiveDate ? { date: effectiveDate } : {}),
			...(options.from ? { from: options.from } : {}),
			...(options.to ? { to: options.to } : {}),
			...(options.sinceMs ? { sinceMs: options.sinceMs } : {}),
			maxSessions,
			maxPrompts,
			maxPromptChars,
		},
		providers: providerResults,
		sessions,
	};
}
