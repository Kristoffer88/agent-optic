import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PrivacyConfig } from "../types/privacy.js";
import type { ProjectInfo } from "../types/project.js";
import type { SessionDetail, SessionInfo, SessionMeta } from "../types/session.js";
import type { TranscriptEntry } from "../types/transcript.js";
import { isProjectExcluded, redactString, shouldRedactStrings, filterTranscriptEntry } from "../privacy/redact.js";
import { projectName } from "../utils/paths.js";
import { toLocalDate } from "../utils/dates.js";

interface OpenCodeNotification {
	directory?: string;
	time?: number;
	type?: string;
	session?: string;
}

interface OpenCodeSessionRecord {
	sessionId: string;
	project: string;
	start: number;
	end: number;
	eventCount: number;
	model?: string;
}

const OPENCODE_METADATA_PROMPT = "(OpenCode metadata-only session; prompt text is not available locally)";
const openCodeRecordCache = new Map<string, Promise<OpenCodeSessionRecord[]>>();
const OPENCODE_CAPABILITIES = ["model", "project", "timestamps"] as const;

function displayProject(project: string, privacy: PrivacyConfig): string {
	return shouldRedactStrings(privacy) ? redactString(project, privacy) : project;
}

function parseNestedJson<T>(value: unknown): T | undefined {
	if (typeof value !== "string") return undefined;
	try {
		return JSON.parse(value) as T;
	} catch {
		return undefined;
	}
}

async function readDat(path: string): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
	} catch {
		return {};
	}
}

async function readModelSelections(baseDir: string): Promise<Map<string, string>> {
	const models = new Map<string, string>();
	let files: string[];
	try {
		files = await readdir(baseDir);
	} catch {
		return models;
	}
	for (const file of files) {
		if (!file.startsWith("opencode.workspace.") || !file.endsWith(".dat")) continue;
		const data = await readDat(join(baseDir, file));
		const selection = parseNestedJson<{ session?: Record<string, { model?: { modelID?: string; providerID?: string } }> }>(data["workspace:model-selection"]);
		for (const [sessionId, entry] of Object.entries(selection?.session ?? {})) {
			const model = entry.model?.modelID;
			const provider = entry.model?.providerID;
			if (model) models.set(sessionId, provider ? `${provider}/${model}` : model);
		}
	}
	return models;
}

async function readRecords(baseDir: string, privacy?: PrivacyConfig): Promise<OpenCodeSessionRecord[]> {
	let promise = openCodeRecordCache.get(baseDir);
	if (!promise) {
		promise = (async () => {
			const data = await readDat(join(baseDir, "opencode.global.dat"));
			const notification = parseNestedJson<{ list?: OpenCodeNotification[] }>(data.notification);
			const modelSelections = await readModelSelections(baseDir);
			const grouped = new Map<string, OpenCodeNotification[]>();
			for (const entry of notification?.list ?? []) {
				if (typeof entry.session !== "string" || typeof entry.directory !== "string" || typeof entry.time !== "number") continue;
				const existing = grouped.get(entry.session) ?? [];
				existing.push(entry);
				grouped.set(entry.session, existing);
			}
			return [...grouped.entries()].map(([sessionId, events]) => {
				const times = events.map((event) => event.time!).sort((a, b) => a - b);
				return {
					sessionId,
					project: events[0].directory!,
					start: times[0],
					end: times[times.length - 1],
					eventCount: events.length,
					model: modelSelections.get(sessionId),
				};
			}).sort((a, b) => a.start - b.start);
		})();
		openCodeRecordCache.set(baseDir, promise);
	}

	const records = await promise;
	return privacy
		? records.filter((record) => !isProjectExcluded(record.project, privacy))
		: records;
}

export async function readOpenCodeHistory(
	baseDir: string,
	from: string,
	to: string,
	privacy: PrivacyConfig,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	for (const record of await readRecords(baseDir, privacy)) {
		if (toLocalDate(record.end) < from || toLocalDate(record.start) > to) continue;
		const project = displayProject(record.project, privacy);
		sessions.push({
			sessionId: record.sessionId,
			project,
			projectName: projectName(project),
			prompts: [OPENCODE_METADATA_PROMPT],
			promptTimestamps: [record.start],
			timeRange: { start: record.start, end: record.end },
			lastFileActivity: Bun.file(join(baseDir, "opencode.global.dat")).lastModified || undefined,
			dataCompleteness: "metadata-only",
			sourceCapabilities: [...OPENCODE_CAPABILITIES],
		});
	}
	return sessions;
}

async function findRecord(baseDir: string, sessionId: string, privacy?: PrivacyConfig): Promise<OpenCodeSessionRecord | undefined> {
	return (await readRecords(baseDir, privacy)).find((record) => record.sessionId === sessionId);
}

export async function peekOpenCodeSession(session: SessionInfo, baseDir: string): Promise<SessionMeta> {
	const record = await findRecord(baseDir, session.sessionId);
	return {
		...session,
		model: record?.model,
		dataCompleteness: "metadata-only",
		sourceCapabilities: [...OPENCODE_CAPABILITIES],
		totalInputTokens: 0,
		totalOutputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
		messageCount: record?.eventCount ?? session.prompts.length,
	};
}

export async function parseOpenCodeSessionDetail(session: SessionInfo, baseDir: string, privacy: PrivacyConfig): Promise<SessionDetail> {
	const record = await findRecord(baseDir, session.sessionId, privacy);
	return {
		...session,
		model: record?.model,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
		messageCount: record?.eventCount ?? session.prompts.length,
		assistantSummaries: ["OpenCode local storage exposed timestamped session metadata, not prompt/transcript text."],
		toolCalls: [],
		filesReferenced: [],
		planReferenced: false,
		thinkingBlockCount: 0,
		hasSidechains: false,
	};
}

export async function* streamOpenCodeTranscript(sessionId: string, baseDir: string, privacy: PrivacyConfig): AsyncGenerator<TranscriptEntry> {
	const record = await findRecord(baseDir, sessionId, privacy);
	if (!record) return;
	const mapped: TranscriptEntry = {
		type: "user",
		timestamp: new Date(record.start).toISOString(),
		cwd: displayProject(record.project, privacy),
		sessionId: record.sessionId,
		message: { role: "user", model: record.model, content: OPENCODE_METADATA_PROMPT },
	};
	const filtered = filterTranscriptEntry(mapped, privacy);
	if (filtered) yield filtered;
}

export async function readOpenCodeProjects(baseDir: string, privacy: PrivacyConfig): Promise<ProjectInfo[]> {
	const counts = new Map<string, number>();
	for (const record of await readRecords(baseDir, privacy)) {
		const project = displayProject(record.project, privacy);
		counts.set(project, (counts.get(project) ?? 0) + 1);
	}
	return [...counts.entries()].map(([decodedPath, sessionCount]) => ({
		encodedPath: basename(decodedPath),
		decodedPath,
		name: projectName(decodedPath),
		sessionCount,
		hasMemory: false,
	})).sort((a, b) => b.sessionCount - a.sessionCount);
}
