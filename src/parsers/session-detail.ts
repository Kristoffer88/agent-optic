import { join } from "node:path";
import type { PrivacyConfig } from "../types/privacy.js";
import type { Provider } from "../types/provider.js";
import type { SessionDetail, SessionInfo, ToolCallSummary } from "../types/session.js";
import type { TranscriptEntry } from "../types/transcript.js";
import { encodeProjectPath } from "../utils/paths.js";
import { canonicalProvider } from "../utils/providers.js";
import { filterTranscriptEntry, redactString } from "../privacy/redact.js";
import { extractText, extractToolCalls, extractFilePaths, countThinkingBlocks } from "./content-blocks.js";
import { categorizeToolName, toolDisplayName } from "./tool-categories.js";
import {
	findRolloutFile,
	parseCodexMessageText,
	parseCodexToolArguments,
} from "../readers/codex-rollout-reader.js";
import { parsePiSessionDetail } from "../readers/pi-session-reader.js";

/**
 * Parse a full session JSONL file into a SessionDetail.
 * This is the "full" tier — reads and parses every line.
 */
export async function parseSessionDetail(
	provider: Provider,
	session: SessionInfo,
	paths: { projectsDir: string; sessionsDir: string },
	privacy: PrivacyConfig,
): Promise<SessionDetail> {
	const normalized = canonicalProvider(provider);
	if (normalized === "pi") {
		return parsePiSessionDetail(session, paths.sessionsDir, privacy);
	}
	if (normalized === "codex") {
		return parseCodexSessionDetail(session, paths.sessionsDir, privacy);
	}
	return parseClaudeSessionDetail(session, paths.projectsDir, privacy);
}

async function parseClaudeSessionDetail(
	session: SessionInfo,
	projectsDir: string,
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

	const encoded = encodeProjectPath(session.project);
	const filePath = join(projectsDir, encoded, `${session.sessionId}.jsonl`);
	const file = Bun.file(filePath);

	if (!(await file.exists())) return detail;

	const text = await file.text();
	const lines = text.split("\n");

	const toolCallSet = new Map<string, ToolCallSummary>();
	const fileSet = new Set<string>();
	let gitBranch: string | undefined;
	let model: string | undefined;

	for (const line of lines) {
		if (!line.trim()) continue;

		let entry: TranscriptEntry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		// Apply privacy filtering
		const filtered = filterTranscriptEntry(entry, privacy);
		if (!filtered) continue;

		// Track sidechains
		if (filtered.isSidechain) {
			detail.hasSidechains = true;
		}

		// Extract git branch
		if (!gitBranch && filtered.gitBranch && filtered.gitBranch !== "HEAD") {
			gitBranch = filtered.gitBranch;
		}

		// Track plan references
		if ((filtered as { planContent?: string }).planContent) {
			detail.planReferenced = true;
		}

		if (!filtered.message) continue;

		const { role, content, model: msgModel, usage } = filtered.message;

		// Extract model
		if (msgModel && !model) {
			model = msgModel;
		}

		// Accumulate tokens
		if (usage) {
			detail.totalInputTokens += usage.input_tokens ?? 0;
			detail.totalOutputTokens += usage.output_tokens ?? 0;
			detail.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
			detail.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
		}

		// Count messages
		if (role === "user" || role === "assistant") {
			detail.messageCount++;
		}

		// Process assistant messages
		if (role === "assistant" && content) {
			const text = extractText(content);
			if (text && text.length > 20) {
				detail.assistantSummaries.push(
					text.slice(0, 200) + (text.length > 200 ? "..." : ""),
				);
			}

			for (const tc of extractToolCalls(content)) {
				toolCallSet.set(tc.displayName, tc);
			}

			for (const fp of extractFilePaths(content)) {
				fileSet.add(fp);
			}

			detail.thinkingBlockCount += countThinkingBlocks(content);
		}
	}

	detail.toolCalls = [...toolCallSet.values()];
	detail.filesReferenced = [...fileSet];
	detail.gitBranch = gitBranch;
	detail.model = model;

	// Limit summaries
	detail.assistantSummaries = detail.assistantSummaries.slice(0, 10);

	return detail;
}

async function parseCodexSessionDetail(
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

	const rolloutPath = await findRolloutFile(sessionsDir, session.sessionId);
	if (!rolloutPath) return detail;

	const file = Bun.file(rolloutPath);
	if (!(await file.exists())) return detail;

	const toolCallSet = new Map<string, ToolCallSummary>();
	const fileSet = new Set<string>();
	let gitBranch: string | undefined;
	let model: string | undefined;

	const text = await file.text();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;

		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry.type === "session_meta") {
			const branch = entry.payload?.git?.branch;
			if (!gitBranch && typeof branch === "string" && branch !== "HEAD") {
				gitBranch = branch;
			}
		} else if (entry.type === "turn_context") {
			const m = entry.payload?.model;
			if (!model && typeof m === "string") {
				model = m;
			}
		} else if (entry.type === "event_msg") {
			if (entry.payload?.type === "token_count") {
				const usage = entry.payload?.info?.last_token_usage;
				if (usage && typeof usage === "object") {
					detail.totalInputTokens += Number(usage.input_tokens ?? 0);
					detail.totalOutputTokens += Number(usage.output_tokens ?? 0);
					detail.cacheReadInputTokens += Number(usage.cached_input_tokens ?? 0);
				}
			}

			if (
				entry.payload?.type === "user_message" ||
				entry.payload?.type === "agent_message"
			) {
				detail.messageCount++;
			}
		} else if (entry.type === "response_item") {
			if (entry.payload?.type === "reasoning") {
				detail.thinkingBlockCount++;
			}

			if (
				entry.payload?.type === "message" &&
				entry.payload?.role === "assistant"
			) {
				const summary = parseCodexMessageText(entry.payload?.content);
				if (summary && summary.length > 20) {
					const redacted =
						privacy.redactPatterns.length > 0 || privacy.redactHomeDir
							? redactString(summary, privacy)
							: summary;
					detail.assistantSummaries.push(
						redacted.slice(0, 200) + (redacted.length > 200 ? "..." : ""),
					);
				}
			}

			if (
				entry.payload?.type === "function_call" &&
				typeof entry.payload?.name === "string"
			) {
				const name = entry.payload.name;
				const input = parseCodexToolArguments(entry.payload.arguments);
				const displayName = toolDisplayName(name, input);
				const target = extractCodexToolTarget(name, input);
				const summary: ToolCallSummary = {
					name,
					displayName,
					category: categorizeToolName(name),
					target,
				};
				toolCallSet.set(displayName, summary);

				const filePath = extractCodexFilePath(input);
				if (filePath) fileSet.add(filePath);
			}
		}
	}

	detail.toolCalls = [...toolCallSet.values()];
	detail.filesReferenced = [...fileSet];
	detail.gitBranch = gitBranch;
	detail.model = model;
	detail.assistantSummaries = detail.assistantSummaries.slice(0, 10);
	return detail;
}

function extractCodexFilePath(input: Record<string, unknown> | undefined): string | undefined {
	if (!input) return undefined;
	const candidates = ["file_path", "path", "target_file", "notebook_path"];
	for (const key of candidates) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function extractCodexToolTarget(
	name: string,
	input: Record<string, unknown> | undefined,
): string | undefined {
	const filePath = extractCodexFilePath(input);
	if (filePath) return filePath;

	if (!input) return undefined;
	for (const key of ["command", "cmd", "pattern", "query"]) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) {
			return key === "command" || key === "cmd" ? value.split(" ")[0] : value;
		}
	}

	if (name === "exec_command" && typeof input.cmd === "string") {
		return input.cmd.split(" ")[0];
	}

	return undefined;
}

/**
 * Parse multiple sessions, splitting into detailed (3+ prompts) and short.
 */
export async function parseSessions(
	provider: Provider,
	sessions: SessionInfo[],
	paths: { projectsDir: string; sessionsDir: string },
	privacy: PrivacyConfig,
): Promise<{ detailed: SessionDetail[]; short: SessionInfo[] }> {
	const detailed: SessionDetail[] = [];
	const short: SessionInfo[] = [];

	for (const session of sessions) {
		if (session.prompts.length >= 3) {
			detailed.push(await parseSessionDetail(provider, session, paths, privacy));
		} else {
			short.push(session);
		}
	}

	return { detailed, short };
}
