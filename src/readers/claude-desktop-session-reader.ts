import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { PrivacyConfig } from "../types/privacy.js";
import type { ProjectInfo } from "../types/project.js";
import type { SessionDetail, SessionInfo, SessionMeta, SourceCapability, ToolCallSummary } from "../types/session.js";
import type { TranscriptEntry } from "../types/transcript.js";
import { isProjectExcluded, redactString, shouldRedactStrings, filterTranscriptEntry } from "../privacy/redact.js";
import { projectName } from "../utils/paths.js";
import { toLocalDate } from "../utils/dates.js";
import { countThinkingBlocks, extractFilePaths, extractText, extractToolCalls } from "../parsers/content-blocks.js";

interface ClaudeDesktopSessionFile {
	sessionId?: string;
	cliSessionId?: string;
	cwd?: string;
	userSelectedFolders?: string[];
	createdAt?: number;
	lastActivityAt?: number;
	model?: string;
	title?: string;
	initialMessage?: string;
	isArchived?: boolean;
	error?: string;
}

interface ClaudeDesktopSessionRecord {
	filePath: string;
	auditPath?: string;
	data: ClaudeDesktopSessionFile & { sessionId: string; createdAt: number };
}

const claudeDesktopRecordCache = new Map<string, Promise<ClaudeDesktopSessionRecord[]>>();
const CLAUDE_DESKTOP_METADATA_CAPABILITIES = ["prompt", "model", "project", "timestamps"] as const;
const CLAUDE_DESKTOP_TRANSCRIPT_CAPABILITIES = [
	"prompt",
	"transcript",
	"assistant-summary",
	"tool-calls",
	"files-referenced",
	"tokens",
	"model",
	"project",
	"timestamps",
] as const;

async function walkLocalSessionFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "skills-plugin") continue;
				await walk(path);
			} else if (entry.isFile() && entry.name.startsWith("local_") && entry.name.endsWith(".json")) {
				out.push(path);
			}
		}
	}
	await walk(root);
	return out;
}

function sessionProject(data: ClaudeDesktopSessionFile): string {
	const selected = data.userSelectedFolders?.find((value) => typeof value === "string" && value.length > 0);
	return selected ?? data.cwd ?? `(claude-desktop)/${data.sessionId ?? "unknown"}`;
}

function sessionPrompt(data: ClaudeDesktopSessionFile, privacy: PrivacyConfig): string {
	const text = data.initialMessage?.trim() || data.title?.trim() || "(no prompt)";
	if (privacy.redactPrompts) return "[redacted]";
	if (shouldRedactStrings(privacy)) return redactString(text, privacy);
	return text;
}

function displayProject(project: string, privacy: PrivacyConfig): string {
	return shouldRedactStrings(privacy) ? redactString(project, privacy) : project;
}

function recordCapabilities(record: ClaudeDesktopSessionRecord): SourceCapability[] {
	return record.auditPath
		? [...CLAUDE_DESKTOP_TRANSCRIPT_CAPABILITIES]
		: [...CLAUDE_DESKTOP_METADATA_CAPABILITIES];
}

function recordCompleteness(record: ClaudeDesktopSessionRecord): SessionInfo["dataCompleteness"] {
	return record.auditPath ? "full" : "prompt-only";
}

function normalizeAuditEntry(raw: unknown): TranscriptEntry | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const entry = raw as TranscriptEntry & { _audit_timestamp?: string; session_id?: string };
	if (!entry.timestamp && typeof entry._audit_timestamp === "string") {
		entry.timestamp = entry._audit_timestamp;
	}
	if (!entry.sessionId && typeof entry.session_id === "string") {
		entry.sessionId = entry.session_id;
	}
	return entry;
}

async function readAuditEntries(record: ClaudeDesktopSessionRecord): Promise<TranscriptEntry[]> {
	if (!record.auditPath) return [];
	try {
		const text = await Bun.file(record.auditPath).text();
		const entries: TranscriptEntry[] = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = normalizeAuditEntry(JSON.parse(line));
				if (entry) entries.push(entry);
			} catch {
				continue;
			}
		}
		return entries;
	} catch {
		return [];
	}
}

function promptFromAuditEntry(entry: TranscriptEntry, privacy: PrivacyConfig): string | undefined {
	if (entry.message?.role !== "user") return undefined;
	const content = entry.message.content;
	const text = typeof content === "string" ? content : extractText(content);
	if (!text.trim()) return undefined;
	if (privacy.redactPrompts) return "[redacted]";
	return shouldRedactStrings(privacy) ? redactString(text.trim(), privacy) : text.trim();
}

async function readRecords(sessionsDir: string, privacy?: PrivacyConfig): Promise<ClaudeDesktopSessionRecord[]> {
	let promise = claudeDesktopRecordCache.get(sessionsDir);
	if (!promise) {
		promise = (async () => {
			const files = await walkLocalSessionFiles(sessionsDir);
			const records: ClaudeDesktopSessionRecord[] = [];
			for (const filePath of files) {
				try {
					const data = JSON.parse(await Bun.file(filePath).text()) as ClaudeDesktopSessionFile;
					if (typeof data.sessionId !== "string" || typeof data.createdAt !== "number") continue;
					const auditPath = join(dirname(filePath), data.sessionId, "audit.jsonl");
					records.push({
						filePath,
						auditPath: await Bun.file(auditPath).exists() ? auditPath : undefined,
						data: data as ClaudeDesktopSessionRecord["data"],
					});
				} catch {
					continue;
				}
			}
			return records.sort((a, b) => a.data.createdAt - b.data.createdAt);
		})();
		claudeDesktopRecordCache.set(sessionsDir, promise);
	}

	const records = await promise;
	return privacy
		? records.filter((record) => !isProjectExcluded(sessionProject(record.data), privacy))
		: records;
}

export async function readClaudeDesktopHistory(
	sessionsDir: string,
	from: string,
	to: string,
	privacy: PrivacyConfig,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	for (const record of await readRecords(sessionsDir, privacy)) {
		const start = record.data.createdAt;
		const end = record.data.lastActivityAt ?? start;
		if (toLocalDate(end) < from || toLocalDate(start) > to) continue;
		const project = displayProject(sessionProject(record.data), privacy);
		const auditPrompts: string[] = [];
		const auditPromptTimestamps: number[] = [];
		for (const entry of await readAuditEntries(record)) {
			const prompt = promptFromAuditEntry(entry, privacy);
			if (!prompt) continue;
			auditPrompts.push(prompt);
			const timestamp = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
			auditPromptTimestamps.push(Number.isFinite(timestamp) ? timestamp : start);
		}
		sessions.push({
			sessionId: record.data.sessionId,
			project,
			projectName: projectName(project),
			prompts: auditPrompts.length > 0 ? auditPrompts : [sessionPrompt(record.data, privacy)],
			promptTimestamps: auditPromptTimestamps.length > 0 ? auditPromptTimestamps : [start],
			timeRange: { start, end },
			lastFileActivity: (record.auditPath ? Bun.file(record.auditPath).lastModified : Bun.file(record.filePath).lastModified) || undefined,
			dataCompleteness: recordCompleteness(record),
			sourceCapabilities: recordCapabilities(record),
		});
	}
	return sessions;
}

async function findRecord(sessionsDir: string, sessionId: string, privacy?: PrivacyConfig): Promise<ClaudeDesktopSessionRecord | undefined> {
	return (await readRecords(sessionsDir, privacy)).find((record) => record.data.sessionId === sessionId || record.data.cliSessionId === sessionId);
}

export async function peekClaudeDesktopSession(session: SessionInfo, sessionsDir: string): Promise<SessionMeta> {
	const record = await findRecord(sessionsDir, session.sessionId);
	const auditEntries = record ? await readAuditEntries(record) : [];
	const usageTotals = auditEntries.reduce(
		(acc, entry) => {
			const usage = entry.message?.usage;
			if (usage) {
				acc.totalInputTokens += usage.input_tokens ?? 0;
				acc.totalOutputTokens += usage.output_tokens ?? 0;
				acc.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
				acc.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
			}
			if (
				(entry.message?.role === "user" || entry.message?.role === "assistant") &&
				!entry.isMeta &&
				entry.message?.model !== "<synthetic>" &&
				entry.toolUseResult === undefined
			) {
				acc.messageCount++;
			}
			return acc;
		},
		{ totalInputTokens: 0, totalOutputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, messageCount: 0 },
	);
	return {
		...session,
		model: auditEntries.find((entry) => entry.message?.model)?.message?.model ?? record?.data.model,
		totalInputTokens: usageTotals.totalInputTokens,
		totalOutputTokens: usageTotals.totalOutputTokens,
		cacheCreationInputTokens: usageTotals.cacheCreationInputTokens,
		cacheReadInputTokens: usageTotals.cacheReadInputTokens,
		messageCount: usageTotals.messageCount || session.prompts.length,
	};
}

export async function parseClaudeDesktopSessionDetail(
	session: SessionInfo,
	sessionsDir: string,
	privacy: PrivacyConfig,
): Promise<SessionDetail> {
	const record = await findRecord(sessionsDir, session.sessionId, privacy);
	const auditEntries = record ? await readAuditEntries(record) : [];
	const auditPrompts: string[] = [];
	const auditPromptTimestamps: number[] = [];
	for (const entry of auditEntries) {
		const prompt = promptFromAuditEntry(entry, privacy);
		if (!prompt) continue;
		auditPrompts.push(prompt);
		const timestamp = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
		auditPromptTimestamps.push(Number.isFinite(timestamp) ? timestamp : record?.data.createdAt ?? session.timeRange.start);
	}
	const effective = record
		? {
				sessionId: record.data.sessionId,
				project: displayProject(sessionProject(record.data), privacy),
				projectName: projectName(displayProject(sessionProject(record.data), privacy)),
				prompts: auditPrompts.length > 0 ? auditPrompts : [sessionPrompt(record.data, privacy)],
				promptTimestamps: auditPromptTimestamps.length > 0 ? auditPromptTimestamps : [record.data.createdAt],
				timeRange: { start: record.data.createdAt, end: record.data.lastActivityAt ?? record.data.createdAt },
				lastFileActivity: (record.auditPath ? Bun.file(record.auditPath).lastModified : Bun.file(record.filePath).lastModified) || undefined,
				dataCompleteness: recordCompleteness(record),
				sourceCapabilities: recordCapabilities(record),
			}
		: session;
	const detail: SessionDetail = {
		...effective,
		model: record?.data.model,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
		messageCount: effective.prompts.length,
		assistantSummaries: record?.data.error ? [record.data.error] : [],
		toolCalls: [],
		filesReferenced: [],
		planReferenced: false,
		thinkingBlockCount: 0,
		hasSidechains: false,
	};

	const toolCallList: ToolCallSummary[] = [];
	const fileSet = new Set<string>();

	for (const entry of auditEntries) {
		const filtered = filterTranscriptEntry(entry, privacy);
		if (!filtered) continue;
		if (filtered.isSidechain) detail.hasSidechains = true;

		const usage = filtered.message?.usage;
		if (usage) {
			detail.totalInputTokens += usage.input_tokens ?? 0;
			detail.totalOutputTokens += usage.output_tokens ?? 0;
			detail.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
			detail.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
		}

		if (!detail.model && filtered.message?.model) detail.model = filtered.message.model;
		if ((filtered as { planContent?: string }).planContent) detail.planReferenced = true;

		const { role, content } = filtered.message ?? {};
		if (
			(role === "user" || role === "assistant") &&
			!filtered.isMeta &&
			filtered.message?.model !== "<synthetic>" &&
			filtered.toolUseResult === undefined
		) {
			detail.messageCount++;
		}

		if (role === "assistant" && content) {
			const text = extractText(content);
			if (text && text.length > 20) {
				detail.assistantSummaries.push(text.slice(0, 200) + (text.length > 200 ? "..." : ""));
			}
			for (const toolCall of extractToolCalls(content, privacy)) toolCallList.push(toolCall);
			for (const filePath of extractFilePaths(content, privacy)) fileSet.add(filePath);
			detail.thinkingBlockCount += countThinkingBlocks(content);
		}
	}

	if (auditEntries.length > 0 && detail.messageCount === 0) {
		detail.messageCount = effective.prompts.length;
	}
	detail.toolCalls = toolCallList;
	detail.filesReferenced = [...fileSet];
	detail.assistantSummaries = detail.assistantSummaries.slice(0, 10);

	return detail;
}

export async function* streamClaudeDesktopTranscript(
	sessionId: string,
	sessionsDir: string,
	privacy: PrivacyConfig,
): AsyncGenerator<TranscriptEntry> {
	const record = await findRecord(sessionsDir, sessionId, privacy);
	if (!record) return;
	for (const entry of await readAuditEntries(record)) {
		const filtered = filterTranscriptEntry(entry, privacy);
		if (filtered) yield filtered;
	}
	if (record.auditPath) return;
	const mapped: TranscriptEntry = {
		type: "user",
		timestamp: new Date(record.data.createdAt).toISOString(),
		cwd: displayProject(sessionProject(record.data), privacy),
		sessionId: record.data.sessionId,
		message: { role: "user", model: record.data.model, content: sessionPrompt(record.data, privacy) },
	};
	const filtered = filterTranscriptEntry(mapped, privacy);
	if (filtered) yield filtered;
}

export async function readClaudeDesktopProjects(sessionsDir: string, privacy: PrivacyConfig): Promise<ProjectInfo[]> {
	const counts = new Map<string, number>();
	for (const record of await readRecords(sessionsDir, privacy)) {
		const project = displayProject(sessionProject(record.data), privacy);
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
