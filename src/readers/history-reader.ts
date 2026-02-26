import { dirname, join } from "node:path";
import type { PrivacyConfig } from "../types/privacy.js";
import type { Provider } from "../types/provider.js";
import type { SessionInfo } from "../types/session.js";
import { toLocalDate } from "../utils/dates.js";
import { projectName } from "../utils/paths.js";
import { canonicalProvider } from "../utils/providers.js";
import { isProjectExcluded, redactString } from "../privacy/redact.js";
import { readCodexSessionHeader } from "./codex-rollout-reader.js";

interface ClaudeHistoryEntry {
	display: string;
	timestamp: number;
	project: string;
	sessionId: string;
	pastedContents?: Record<string, unknown>;
}

interface CodexHistoryEntry {
	session_id: string;
	ts: number;
	text: string;
}

/**
 * Read history.jsonl and group entries into SessionInfo objects.
 * This is the fast path — no session file reads, just history.jsonl.
 */
export async function readHistory(
	historyFile: string,
	from: string,
	to: string,
	privacy: PrivacyConfig,
	options?: {
		provider?: Provider;
		sessionsDir?: string;
	},
): Promise<SessionInfo[]> {
	const provider = canonicalProvider(options?.provider ?? "claude");
	if (provider === "codex") {
		return readCodexHistory(
			historyFile,
			from,
			to,
			privacy,
			options?.sessionsDir ?? join(dirname(historyFile), "sessions"),
		);
	}
	return readClaudeHistory(historyFile, from, to, privacy);
}

async function readClaudeHistory(
	historyFile: string,
	from: string,
	to: string,
	privacy: PrivacyConfig,
): Promise<SessionInfo[]> {
	const file = Bun.file(historyFile);
	if (!(await file.exists())) return [];

	const text = await file.text();
	const entries: ClaudeHistoryEntry[] = [];

	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as ClaudeHistoryEntry;
			const entryDate = toLocalDate(entry.timestamp);

			// Early exit: skip entries outside date range
			if (entryDate < from || entryDate > to) continue;

			// Privacy: skip excluded projects
			if (isProjectExcluded(entry.project, privacy)) continue;

			entries.push(entry);
		} catch {
			// skip malformed
		}
	}

	// Group by sessionId
	const sessionMap = new Map<
		string,
		{ project: string; prompts: string[]; timestamps: number[] }
	>();

	for (const entry of entries) {
		const existing = sessionMap.get(entry.sessionId);
		const display = privacy.redactPrompts
			? "[redacted]"
			: privacy.redactPatterns.length > 0
				? redactString(entry.display, privacy)
				: entry.display;

		if (existing) {
			existing.prompts.push(display);
			existing.timestamps.push(entry.timestamp);
		} else {
			sessionMap.set(entry.sessionId, {
				project: entry.project,
				prompts: [display],
				timestamps: [entry.timestamp],
			});
		}
	}

	const sessions: SessionInfo[] = [];
	for (const [sessionId, data] of sessionMap) {
		sessions.push({
			sessionId,
			project: data.project,
			projectName: projectName(data.project),
			prompts: data.prompts,
			promptTimestamps: data.timestamps,
			timeRange: {
				start: Math.min(...data.timestamps),
				end: Math.max(...data.timestamps),
			},
		});
	}

	sessions.sort((a, b) => a.timeRange.start - b.timeRange.start);
	return sessions;
}

async function readCodexHistory(
	historyFile: string,
	from: string,
	to: string,
	privacy: PrivacyConfig,
	sessionsDir: string,
): Promise<SessionInfo[]> {
	const file = Bun.file(historyFile);
	if (!(await file.exists())) return [];

	const text = await file.text();
	const entries: CodexHistoryEntry[] = [];

	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as CodexHistoryEntry;
			if (
				typeof entry.session_id !== "string" ||
				typeof entry.ts !== "number" ||
				typeof entry.text !== "string"
			) {
				continue;
			}
			const timestampMs = entry.ts * 1000;
			const entryDate = toLocalDate(timestampMs);
			if (entryDate < from || entryDate > to) continue;
			entries.push(entry);
		} catch {
			// skip malformed
		}
	}

	const sessionMap = new Map<string, { prompts: string[]; timestamps: number[] }>();
	for (const entry of entries) {
		const existing = sessionMap.get(entry.session_id);
		const prompt = privacy.redactPrompts
			? "[redacted]"
			: privacy.redactPatterns.length > 0
				? redactString(entry.text, privacy)
				: entry.text;

		const timestampMs = entry.ts * 1000;
		if (existing) {
			existing.prompts.push(prompt);
			existing.timestamps.push(timestampMs);
		} else {
			sessionMap.set(entry.session_id, {
				prompts: [prompt],
				timestamps: [timestampMs],
			});
		}
	}

	const sessions = await Promise.all(
		[...sessionMap.entries()].map(async ([sessionId, data]): Promise<SessionInfo | null> => {
			const header = await readCodexSessionHeader(sessionsDir, sessionId);
			const project = header.cwd ?? `(unknown)/${sessionId}`;

			if (isProjectExcluded(project, privacy)) return null;

			return {
				sessionId,
				project,
				projectName: projectName(project),
				prompts: data.prompts,
				promptTimestamps: data.timestamps,
				timeRange: {
					start: Math.min(...data.timestamps),
					end: Math.max(...data.timestamps),
				},
			};
		}),
	);

	return sessions
		.filter((session): session is SessionInfo => !!session)
		.sort((a, b) => a.timeRange.start - b.timeRange.start);
}
