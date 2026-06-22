import { basename, dirname, join } from "node:path";
import type { PrivacyConfig } from "../types/privacy.js";
import type { Provider } from "../types/provider.js";
import type { SessionInfo } from "../types/session.js";
import type { TranscriptEntry } from "../types/transcript.js";
import { toLocalDate } from "../utils/dates.js";
import { projectName, unknownProject } from "../utils/paths.js";
import { canonicalProvider } from "../utils/providers.js";
import { isProjectExcluded, redactString } from "../privacy/redact.js";
import { readCodexSessionHeader } from "./codex-rollout-reader.js";
import { readPiHistory } from "./pi-session-reader.js";
import { readCopilotHistory } from "./copilot-session-reader.js";

interface ClaudeHistoryEntry {
	display: string;
	timestamp: number;
	project: string;
	sessionId: string;
	pastedContents?: Record<string, unknown>;
}

interface LegacyCodexHistoryEntry {
	session_id: string;
	ts: number;
	text: string;
}

interface CodexDesktopIndexEntry {
	id: string;
	thread_name?: string;
	updated_at: string;
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
	if (provider === "pi") {
		return readPiHistory(
			options?.sessionsDir ?? join(dirname(historyFile), "sessions"),
			from, to, privacy,
		);
	}
	if (provider === "copilot") {
		return readCopilotHistory(
			options?.sessionsDir ?? join(dirname(historyFile), "session-state"),
			from, to, privacy,
		);
	}
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
	// history.jsonl may be absent (e.g. a projects/ dir copied out of a container).
	// Don't bail — fall through to the projects/ directory scan below.
	const text = (await file.exists()) ? await file.text() : "";
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

	// Discovery fallback: history.jsonl may be missing (e.g. a projects/ dir
	// copied out of a container) or stale. Scan the projects dir for any session
	// files not already covered and build SessionInfo straight from the transcript.
	const projectsDir = join(dirname(historyFile), "projects");
	const known = new Set(sessions.map((s) => s.sessionId));
	for (const scanned of await scanClaudeProjects(projectsDir, from, to, privacy)) {
		if (!known.has(scanned.sessionId)) sessions.push(scanned);
	}

	sessions.sort((a, b) => a.timeRange.start - b.timeRange.start);
	return sessions;
}

/** Extract a user-typed prompt from a Claude transcript record (skips tool-result carriers and meta). */
function claudeUserPromptText(entry: TranscriptEntry): string | undefined {
	if (entry.type !== "user" || entry.isMeta || entry.isSidechain) return undefined;
	const content = entry.message?.content;
	if (typeof content === "string") return content.trim() || undefined;
	if (Array.isArray(content)) {
		// A user record whose content carries a tool_result is a tool-result carrier, not a prompt.
		if (content.some((b) => b.type === "tool_result")) return undefined;
		const text = content
			.filter((b) => b.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join("\n")
			.trim();
		return text || undefined;
	}
	return undefined;
}

/**
 * Discover Claude sessions by scanning the projects/ directory directly.
 * Used as a fallback when history.jsonl is absent or incomplete.
 */
async function scanClaudeProjects(
	projectsDir: string,
	from: string,
	to: string,
	privacy: PrivacyConfig,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	const glob = new Bun.Glob("*/*.jsonl");

	for await (const rel of glob.scan({ cwd: projectsDir, absolute: false })) {
		const sessionId = basename(rel, ".jsonl");
		const file = Bun.file(join(projectsDir, rel));

		// Cheap pre-filter: a file last written before the window can't hold in-range records.
		const mtime = file.lastModified;
		if (mtime && toLocalDate(mtime) < from) continue;

		let text: string;
		try {
			text = await file.text();
		} catch {
			continue;
		}

		let project: string | undefined;
		const prompts: string[] = [];
		const promptTimestamps: number[] = [];
		let minTs = Infinity;
		let maxTs = -Infinity;

		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let entry: TranscriptEntry;
			try {
				entry = JSON.parse(line) as TranscriptEntry;
			} catch {
				continue;
			}

			if (!project && entry.cwd) project = entry.cwd;

			const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
			if (!Number.isNaN(ts)) {
				if (ts < minTs) minTs = ts;
				if (ts > maxTs) maxTs = ts;
			}

			const promptText = claudeUserPromptText(entry);
			if (promptText) {
				const display = privacy.redactPrompts
					? "[redacted]"
					: privacy.redactPatterns.length > 0
						? redactString(promptText, privacy)
						: promptText;
				prompts.push(display);
				if (!Number.isNaN(ts)) promptTimestamps.push(ts);
			}
		}

		const resolvedProject = project ?? unknownProject(sessionId);
		if (isProjectExcluded(resolvedProject, privacy)) continue;

		const start = minTs === Infinity ? 0 : minTs;
		const end = maxTs === -Infinity ? start : maxTs;

		// Date filter: keep sessions whose activity overlaps the window.
		if (toLocalDate(end) < from || toLocalDate(start) > to) continue;

		sessions.push({
			sessionId,
			project: resolvedProject,
			projectName: projectName(resolvedProject),
			prompts: prompts.length > 0 ? prompts : ["(no prompt)"],
			promptTimestamps: promptTimestamps.length > 0 ? promptTimestamps : [start],
			timeRange: { start, end },
			lastFileActivity: mtime || undefined,
		});
	}

	return sessions;
}

async function readCodexHistory(
	historyFile: string,
	from: string,
	to: string,
	privacy: PrivacyConfig,
	sessionsDir: string,
): Promise<SessionInfo[]> {
	const sessionMap = new Map<string, { prompts: string[]; timestamps: number[] }>();

	for (const indexFile of codexIndexFiles(historyFile)) {
		const file = Bun.file(indexFile);
		if (!(await file.exists())) continue;

		const text = await file.text();
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const normalized = normalizeCodexIndexEntry(JSON.parse(line));
				if (!normalized) continue;

				const entryDate = toLocalDate(normalized.timestampMs);
				if (entryDate < from || entryDate > to) continue;

				const prompt = privacy.redactPrompts
					? "[redacted]"
					: privacy.redactPatterns.length > 0
						? redactString(normalized.prompt, privacy)
						: normalized.prompt;

				const existing = sessionMap.get(normalized.sessionId);
				if (existing) {
					existing.prompts.push(prompt);
					existing.timestamps.push(normalized.timestampMs);
				} else {
					sessionMap.set(normalized.sessionId, {
						prompts: [prompt],
						timestamps: [normalized.timestampMs],
					});
				}
			} catch {
				// skip malformed
			}
		}
	}

	for (const scanned of await scanCodexRollouts(sessionsDir, from, to, privacy)) {
		if (!sessionMap.has(scanned.sessionId)) {
			sessionMap.set(scanned.sessionId, {
				prompts: scanned.prompts,
				timestamps: scanned.promptTimestamps,
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

function codexIndexFiles(historyFile: string): string[] {
	return [...new Set([
		historyFile,
		join(dirname(historyFile), "session_index.jsonl"),
	])];
}

function normalizeCodexIndexEntry(
	entry: unknown,
): { sessionId: string; timestampMs: number; prompt: string } | null {
	if (!entry || typeof entry !== "object") return null;
	const e = entry as Partial<LegacyCodexHistoryEntry & CodexDesktopIndexEntry>;

	if (
		typeof e.session_id === "string" &&
		typeof e.ts === "number" &&
		typeof e.text === "string"
	) {
		return {
			sessionId: e.session_id,
			timestampMs: e.ts * 1000,
			prompt: e.text,
		};
	}

	if (typeof e.id === "string" && typeof e.updated_at === "string") {
		const timestampMs = Date.parse(e.updated_at);
		if (Number.isNaN(timestampMs)) return null;
		return {
			sessionId: e.id,
			timestampMs,
			prompt: typeof e.thread_name === "string" && e.thread_name.length > 0
				? e.thread_name
				: "(untitled Codex session)",
		};
	}

	return null;
}

async function scanCodexRollouts(
	sessionsDir: string,
	from: string,
	to: string,
	privacy: PrivacyConfig,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	const glob = new Bun.Glob("**/*.jsonl");

	for await (const rel of glob.scan({ cwd: sessionsDir, absolute: false })) {
		const parsed = parseCodexRolloutPath(rel);
		if (!parsed) continue;
		if (parsed.date < from || parsed.date > to) continue;

		const header = await readCodexSessionHeader(sessionsDir, parsed.sessionId);
		const project = header.cwd ?? unknownProject(parsed.sessionId);
		if (isProjectExcluded(project, privacy)) continue;

		const prompt = privacy.redactPrompts ? "[redacted]" : "(no index entry)";
		sessions.push({
			sessionId: parsed.sessionId,
			project,
			projectName: projectName(project),
			prompts: [prompt],
			promptTimestamps: [parsed.timestampMs],
			timeRange: {
				start: parsed.timestampMs,
				end: parsed.timestampMs,
			},
			lastFileActivity: Bun.file(join(sessionsDir, rel)).lastModified || undefined,
		});
	}

	return sessions;
}

function parseCodexRolloutPath(
	path: string,
): { date: string; timestampMs: number; sessionId: string } | null {
	const filename = basename(path);
	const m = filename.match(
		/^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)\.jsonl$/,
	);
	if (!m) return null;
	const [, date, hour, minute, second, sessionId] = m;
	const timestampMs = Date.parse(`${date}T${hour}:${minute}:${second}Z`);
	if (Number.isNaN(timestampMs)) return null;
	return { date, timestampMs, sessionId };
}
