import { join } from "node:path";
import type { PrivacyConfig } from "../types/privacy.js";
import type { SessionDetail, SessionInfo, SessionMeta, ToolCallSummary } from "../types/session.js";
import type { ContentBlock, TranscriptEntry } from "../types/transcript.js";
import { projectName } from "../utils/paths.js";
import { toLocalDate } from "../utils/dates.js";
import { isProjectExcluded, redactString, filterTranscriptEntry } from "../privacy/redact.js";
import { categorizeToolName, toolDisplayName } from "../parsers/tool-categories.js";

// Copilot CLI session layout:
//   ~/.copilot/session-state/{uuid}/workspace.yaml  — always present, metadata
//   ~/.copilot/session-state/{uuid}/events.jsonl    — present only when session had interactions
//
// workspace.yaml keys: id, cwd, branch, summary, created_at, updated_at, git_root, repository

/** Parse simple flat YAML (key: value lines). No library required. */
function parseSimpleYaml(text: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1).trim();
		if (key && value) result[key] = value;
	}
	return result;
}

function eventsPath(sessionsDir: string, sessionId: string): string {
	return join(sessionsDir, sessionId, "events.jsonl");
}

function workspacePath(sessionsDir: string, sessionId: string): string {
	return join(sessionsDir, sessionId, "workspace.yaml");
}

function accumulateCopilotTokens(
	metrics: unknown,
	target: { totalInputTokens: number; totalOutputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number },
): void {
	if (!metrics || typeof metrics !== "object") return;
	for (const modelStats of Object.values(metrics) as any[]) {
		const usage = modelStats?.usage;
		if (!usage) continue;
		target.totalInputTokens += Number(usage.inputTokens ?? 0);
		target.totalOutputTokens += Number(usage.outputTokens ?? 0);
		target.cacheReadInputTokens += Number(usage.cacheReadTokens ?? 0);
		target.cacheCreationInputTokens += Number(usage.cacheWriteTokens ?? 0);
	}
}

async function readCopilotBranch(session: SessionInfo, sessionsDir: string): Promise<string | undefined> {
	if ((session as SessionMeta).gitBranch) return (session as SessionMeta).gitBranch;
	const wsFile = Bun.file(workspacePath(sessionsDir, session.sessionId));
	if (!(await wsFile.exists())) return undefined;
	try {
		const ws = parseSimpleYaml(await wsFile.text());
		if (ws.branch && ws.branch !== "HEAD") return ws.branch;
	} catch {}
	return undefined;
}

function parseTs(ts: unknown): number {
	if (typeof ts === "number") return ts;
	if (typeof ts === "string") {
		const n = new Date(ts).getTime();
		return isNaN(n) ? 0 : n;
	}
	return 0;
}

/** Read all Copilot CLI sessions by scanning session-state/ (no history.jsonl). */
export async function readCopilotHistory(
	sessionsDir: string,
	from: string,
	to: string,
	privacy: PrivacyConfig,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	const glob = new Bun.Glob("*/workspace.yaml");

	for await (const relPath of glob.scan({ cwd: sessionsDir, absolute: false })) {
		const sessionId = relPath.split("/")[0];
		const wsFile = Bun.file(join(sessionsDir, relPath));
		if (!(await wsFile.exists())) continue;

		let ws: Record<string, string>;
		try {
			ws = parseSimpleYaml(await wsFile.text());
		} catch {
			continue;
		}

		const cwd = ws.cwd;
		const branch = ws.branch;
		const startTime = parseTs(ws.created_at);
		if (!cwd || !startTime) continue;

		const startDate = toLocalDate(startTime);
		if (startDate < from || startDate > to) continue;
		if (isProjectExcluded(cwd, privacy)) continue;

		// Try to get first user prompt from events.jsonl (best-effort, skip if absent)
		let firstPrompt: string | undefined;
		let endTime = startTime;
		const evFile = Bun.file(eventsPath(sessionsDir, sessionId));
		if (await evFile.exists()) {
			try {
				const text = await evFile.text();
				for (const line of text.split("\n")) {
					if (!line.trim()) continue;
					let entry: any;
					try { entry = JSON.parse(line); } catch { continue; }

					const ts = parseTs(entry.timestamp);
					if (ts > endTime) endTime = ts;

					if (entry.type === "user.message" && !firstPrompt) {
						const content = entry.data?.content;
						if (typeof content === "string" && content.trim()) firstPrompt = content;
					}
				}
			} catch {
				// events.jsonl unreadable — use workspace summary as fallback
			}
		}

		// Fall back to workspace summary for sessions without events
		if (!firstPrompt && ws.summary) firstPrompt = ws.summary;

		const prompt = firstPrompt
			? privacy.redactPrompts
				? "[redacted]"
				: privacy.redactPatterns.length > 0
					? redactString(firstPrompt, privacy)
					: firstPrompt
			: "(no prompt)";

		const session: SessionInfo = {
			sessionId,
			project: cwd,
			projectName: projectName(cwd),
			prompts: [prompt],
			promptTimestamps: [startTime],
			timeRange: { start: startTime, end: endTime },
		};

		if (branch && branch !== "HEAD") {
			(session as SessionMeta).gitBranch = branch;
		}

		sessions.push(session);
	}

	sessions.sort((a, b) => a.timeRange.start - b.timeRange.start);
	return sessions;
}

/** Peek Copilot session metadata (model, tokens, branch). */
export async function peekCopilotSession(
	session: SessionInfo,
	sessionsDir: string,
): Promise<SessionMeta> {
	const meta: SessionMeta = {
		...session,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
		messageCount: 0,
	};

	meta.gitBranch = await readCopilotBranch(session, sessionsDir);

	const file = Bun.file(eventsPath(sessionsDir, session.sessionId));
	if (!(await file.exists())) return meta;

	try {
		const text = await file.text();
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let entry: any;
			try { entry = JSON.parse(line); } catch { continue; }

			if (entry.type === "session.model_change" && !meta.model) {
				const model = entry.data?.newModel;
				if (typeof model === "string") meta.model = model;
			}

			if (entry.type === "user.message") meta.messageCount++;
			if (entry.type === "assistant.message") meta.messageCount++;

			// session.shutdown carries accurate cumulative token totals per model
			if (entry.type === "session.shutdown") {
				accumulateCopilotTokens(entry.data?.modelMetrics, meta);
				if (!meta.model) {
					const current = entry.data?.currentModel;
					if (typeof current === "string") meta.model = current;
				}
			}
		}
	} catch {
		// file unreadable
	}

	return meta;
}

/** Parse full Copilot session detail. */
export async function parseCopilotSessionDetail(
	session: SessionInfo,
	sessionsDir: string,
	privacy: PrivacyConfig,
): Promise<SessionDetail> {
	const detail: SessionDetail = {
		...session,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
		messageCount: 0,
		assistantSummaries: [],
		toolCalls: [],
		filesReferenced: [],
		planReferenced: false,
		thinkingBlockCount: 0,
		hasSidechains: false,
	};

	detail.gitBranch = await readCopilotBranch(session, sessionsDir);

	const file = Bun.file(eventsPath(sessionsDir, session.sessionId));
	if (!(await file.exists())) return detail;

	const toolCallSet = new Map<string, ToolCallSummary>();
	const fileSet = new Set<string>();
	let model: string | undefined;

	try {
		const text = await file.text();
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let entry: any;
			try { entry = JSON.parse(line); } catch { continue; }

			if (entry.type === "session.model_change" && !model) {
				const m = entry.data?.newModel;
				if (typeof m === "string") model = m;
			}

			if (entry.type === "session.shutdown") {
				accumulateCopilotTokens(entry.data?.modelMetrics, detail);
				if (!model) {
					const current = entry.data?.currentModel;
					if (typeof current === "string") model = current;
				}
			}

			if (entry.type === "user.message") {
				detail.messageCount++;
			}

			if (entry.type === "assistant.message") {
				detail.messageCount++;

				// Count thinking block
				if (typeof entry.data?.reasoningText === "string" && entry.data.reasoningText) {
					detail.thinkingBlockCount++;
				}

				const textContent = entry.data?.content;
				if (typeof textContent === "string" && textContent.length > 20) {
					const redacted =
						privacy.redactPatterns.length > 0 || privacy.redactHomeDir
							? redactString(textContent, privacy)
							: textContent;
					detail.assistantSummaries.push(
						redacted.slice(0, 200) + (redacted.length > 200 ? "..." : ""),
					);
				}

				const toolRequests = entry.data?.toolRequests;
				if (Array.isArray(toolRequests)) {
					for (const req of toolRequests) {
						const name = req.name ?? req.toolName;
						if (typeof name !== "string") continue;
						const input =
							req.arguments && typeof req.arguments === "object"
								? req.arguments
								: undefined;
						const displayName = toolDisplayName(name, input);
						toolCallSet.set(displayName, {
							name,
							displayName,
							category: categorizeToolName(name),
							target: extractToolTarget(name, input),
						});
						const fp = extractFilePath(input);
						if (fp) fileSet.add(fp);
					}
				}
			}
		}
	} catch {
		// file unreadable
	}

	detail.toolCalls = [...toolCallSet.values()];
	detail.filesReferenced = [...fileSet];
	detail.model = model;
	detail.assistantSummaries = detail.assistantSummaries.slice(0, 10);
	return detail;
}

/** Stream Copilot transcript entries with privacy filtering. */
export async function* streamCopilotTranscript(
	sessionId: string,
	sessionsDir: string,
	privacy: PrivacyConfig,
): AsyncGenerator<TranscriptEntry> {
	const file = Bun.file(eventsPath(sessionsDir, sessionId));
	if (!(await file.exists())) return;

	let currentModel: string | undefined;

	const text = await file.text();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let raw: any;
		try { raw = JSON.parse(line); } catch { continue; }

		if (raw.type === "session.model_change") {
			const m = raw.data?.newModel;
			if (typeof m === "string") currentModel = m;
			continue;
		}

		let mapped: TranscriptEntry | null = null;
		const ts = parseTs(raw.timestamp);
		const tsIso = ts ? new Date(ts).toISOString() : undefined;

		if (raw.type === "user.message") {
			const content = raw.data?.content;
			mapped = {
				timestamp: tsIso,
				message: {
					role: "user",
					content: typeof content === "string" ? content : "",
				},
			};
		} else if (raw.type === "assistant.message") {
			const blocks: ContentBlock[] = [];

			if (typeof raw.data?.reasoningText === "string" && raw.data.reasoningText) {
				blocks.push({ type: "thinking", thinking: raw.data.reasoningText });
			}

			const textContent = raw.data?.content;
			if (typeof textContent === "string" && textContent) {
				blocks.push({ type: "text", text: textContent });
			}

			const toolRequests = raw.data?.toolRequests;
			if (Array.isArray(toolRequests)) {
				for (const req of toolRequests) {
					const name = req.name ?? req.toolName;
					if (typeof name === "string") {
						blocks.push({
							type: "tool_use",
							name,
							id: req.toolCallId,
							input:
								req.arguments && typeof req.arguments === "object"
									? req.arguments
									: undefined,
						});
					}
				}
			}

			mapped = {
				timestamp: tsIso,
				message: {
					role: "assistant",
					model: currentModel,
					content: blocks,
				},
			};
		} else if (raw.type === "tool.execution_complete") {
			const result = raw.data?.result;
			const output =
				typeof result?.content === "string"
					? result.content
					: typeof result?.detailedContent === "string"
						? result.detailedContent
						: undefined;
			mapped = {
				timestamp: tsIso,
				toolUseResult: output,
			};
		}

		if (!mapped) continue;
		const filtered = filterTranscriptEntry(mapped, privacy);
		if (filtered) yield filtered;
	}
}

function extractFilePath(input: Record<string, unknown> | undefined): string | undefined {
	if (!input) return undefined;
	for (const key of ["file_path", "path", "target_file", "filename"]) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function extractToolTarget(
	_name: string,
	input: Record<string, unknown> | undefined,
): string | undefined {
	const fp = extractFilePath(input);
	if (fp) return fp;
	if (!input) return undefined;
	for (const key of ["command", "pattern", "query"]) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) {
			return key === "command" ? value.split(" ")[0] : value;
		}
	}
	return undefined;
}
