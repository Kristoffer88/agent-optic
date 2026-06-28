import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PrivacyConfig } from "../types/privacy.js";
import type { ProjectInfo } from "../types/project.js";
import type { SessionDetail, SessionInfo, SessionMeta } from "../types/session.js";
import type { TranscriptEntry } from "../types/transcript.js";
import { isProjectExcluded, redactString, shouldRedactStrings, filterTranscriptEntry } from "../privacy/redact.js";
import { projectName } from "../utils/paths.js";
import { toLocalDate } from "../utils/dates.js";

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
	data: ClaudeDesktopSessionFile & { sessionId: string; createdAt: number };
}

const claudeDesktopRecordCache = new Map<string, Promise<ClaudeDesktopSessionRecord[]>>();
const CLAUDE_DESKTOP_CAPABILITIES = ["prompt", "model", "project", "timestamps"] as const;

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
					records.push({ filePath, data: data as ClaudeDesktopSessionRecord["data"] });
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
		sessions.push({
			sessionId: record.data.sessionId,
			project,
			projectName: projectName(project),
			prompts: [sessionPrompt(record.data, privacy)],
			promptTimestamps: [start],
			timeRange: { start, end },
			lastFileActivity: Bun.file(record.filePath).lastModified || undefined,
			dataCompleteness: "prompt-only",
			sourceCapabilities: [...CLAUDE_DESKTOP_CAPABILITIES],
		});
	}
	return sessions;
}

async function findRecord(sessionsDir: string, sessionId: string, privacy?: PrivacyConfig): Promise<ClaudeDesktopSessionRecord | undefined> {
	return (await readRecords(sessionsDir, privacy)).find((record) => record.data.sessionId === sessionId || record.data.cliSessionId === sessionId);
}

export async function peekClaudeDesktopSession(session: SessionInfo, sessionsDir: string): Promise<SessionMeta> {
	const record = await findRecord(sessionsDir, session.sessionId);
	return {
		...session,
		model: record?.data.model,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
		messageCount: session.prompts.length,
	};
}

export async function parseClaudeDesktopSessionDetail(
	session: SessionInfo,
	sessionsDir: string,
	privacy: PrivacyConfig,
): Promise<SessionDetail> {
	const record = await findRecord(sessionsDir, session.sessionId, privacy);
	const effective = record
		? {
				sessionId: record.data.sessionId,
				project: displayProject(sessionProject(record.data), privacy),
				projectName: projectName(displayProject(sessionProject(record.data), privacy)),
				prompts: [sessionPrompt(record.data, privacy)],
				promptTimestamps: [record.data.createdAt],
				timeRange: { start: record.data.createdAt, end: record.data.lastActivityAt ?? record.data.createdAt },
				lastFileActivity: Bun.file(record.filePath).lastModified || undefined,
				dataCompleteness: "prompt-only" as const,
				sourceCapabilities: [...CLAUDE_DESKTOP_CAPABILITIES],
			}
		: session;
	return {
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
}

export async function* streamClaudeDesktopTranscript(
	sessionId: string,
	sessionsDir: string,
	privacy: PrivacyConfig,
): AsyncGenerator<TranscriptEntry> {
	const record = await findRecord(sessionsDir, sessionId, privacy);
	if (!record) return;
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
