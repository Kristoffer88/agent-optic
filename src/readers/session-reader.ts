import { join } from "node:path";
import type { PrivacyConfig } from "../types/privacy.js";
import type { Provider } from "../types/provider.js";
import type { SessionInfo, SessionMeta } from "../types/session.js";
import type { ContentBlock, TranscriptEntry } from "../types/transcript.js";
import { encodeProjectPath } from "../utils/paths.js";
import { canonicalProvider } from "../utils/providers.js";
import { filterTranscriptEntry } from "../privacy/redact.js";
import {
	findRolloutFile,
	parseCodexMessageText,
	parseCodexToolArguments,
} from "./codex-rollout-reader.js";

/**
 * Peek session metadata from a session JSONL file.
 * Reads the entire file but only extracts lightweight metadata.
 * This is the "medium" tier — slower than history.jsonl only, but still avoids full parsing.
 */
export async function peekSession(
	provider: Provider,
	session: SessionInfo,
	paths: { projectsDir: string; sessionsDir: string },
	privacy: PrivacyConfig,
): Promise<SessionMeta> {
	const normalized = canonicalProvider(provider);
	if (normalized === "codex") {
		return peekCodexSession(session, paths.sessionsDir);
	}
	return peekClaudeSession(session, paths.projectsDir);
}

async function peekClaudeSession(
	session: SessionInfo,
	projectsDir: string,
): Promise<SessionMeta> {
	const meta: SessionMeta = {
		...session,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
		messageCount: 0,
	};

	const encoded = encodeProjectPath(session.project);
	const filePath = join(projectsDir, encoded, `${session.sessionId}.jsonl`);
	const file = Bun.file(filePath);
	if (!(await file.exists())) return meta;

	try {
		const text = await file.text();
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as TranscriptEntry;

				// Extract git branch from first occurrence
				if (!meta.gitBranch && entry.gitBranch && entry.gitBranch !== "HEAD") {
					meta.gitBranch = entry.gitBranch;
				}

				// Extract model from first assistant message
				if (!meta.model && entry.message?.model) {
					meta.model = entry.message.model;
				}

				// Accumulate token usage
				const usage = entry.message?.usage;
				if (usage) {
					meta.totalInputTokens += usage.input_tokens ?? 0;
					meta.totalOutputTokens += usage.output_tokens ?? 0;
					meta.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
					meta.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
				}

				// Count messages (user + assistant only)
				if (entry.message?.role === "user" || entry.message?.role === "assistant") {
					meta.messageCount++;
				}
			} catch {
				// skip malformed
			}
		}
	} catch {
		// file unreadable
	}

	return meta;
}

async function peekCodexSession(
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

	const rolloutPath = await findRolloutFile(sessionsDir, session.sessionId);
	if (!rolloutPath) return meta;

	const file = Bun.file(rolloutPath);
	if (!(await file.exists())) return meta;

	try {
		const text = await file.text();
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as any;

				if (entry.type === "session_meta") {
					const branch = entry.payload?.git?.branch;
					if (!meta.gitBranch && typeof branch === "string" && branch !== "HEAD") {
						meta.gitBranch = branch;
					}
				}

				if (entry.type === "turn_context") {
					const model = entry.payload?.model;
					if (!meta.model && typeof model === "string") {
						meta.model = model;
					}
				}

				if (entry.type === "event_msg" && entry.payload?.type === "token_count") {
					const usage = entry.payload?.info?.last_token_usage;
					if (usage && typeof usage === "object") {
						meta.totalInputTokens += Number(usage.input_tokens ?? 0);
						meta.totalOutputTokens += Number(usage.output_tokens ?? 0);
						meta.cacheReadInputTokens += Number(usage.cached_input_tokens ?? 0);
					}
				}

				if (
					entry.type === "response_item" &&
					entry.payload?.type === "message" &&
					(entry.payload?.role === "user" || entry.payload?.role === "assistant")
				) {
					meta.messageCount++;
				}
			} catch {
				// skip malformed
			}
		}
	} catch {
		// file unreadable
	}

	return meta;
}

/**
 * Stream transcript entries from a session JSONL file with privacy filtering.
 */
export async function* streamTranscript(
	provider: Provider,
	sessionId: string,
	projectPath: string,
	paths: { projectsDir: string; sessionsDir: string },
	privacy: PrivacyConfig,
): AsyncGenerator<TranscriptEntry> {
	const normalized = canonicalProvider(provider);
	if (normalized === "codex") {
		yield* streamCodexTranscript(sessionId, paths.sessionsDir, privacy);
		return;
	}

	yield* streamClaudeTranscript(sessionId, projectPath, paths.projectsDir, privacy);
}

async function* streamClaudeTranscript(
	sessionId: string,
	projectPath: string,
	projectsDir: string,
	privacy: PrivacyConfig,
): AsyncGenerator<TranscriptEntry> {
	const encoded = encodeProjectPath(projectPath);
	const filePath = join(projectsDir, encoded, `${sessionId}.jsonl`);
	const file = Bun.file(filePath);
	if (!(await file.exists())) return;

	const text = await file.text();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as TranscriptEntry;
			const filtered = filterTranscriptEntry(entry, privacy);
			if (filtered) yield filtered;
		} catch {
			// skip malformed
		}
	}
}

async function* streamCodexTranscript(
	sessionId: string,
	sessionsDir: string,
	privacy: PrivacyConfig,
): AsyncGenerator<TranscriptEntry> {
	const rolloutPath = await findRolloutFile(sessionsDir, sessionId);
	if (!rolloutPath) return;

	const file = Bun.file(rolloutPath);
	if (!(await file.exists())) return;

	let currentModel: string | undefined;

	const text = await file.text();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let raw: any;
		try {
			raw = JSON.parse(line);
		} catch {
			continue;
		}

		if (raw.type === "turn_context" && typeof raw.payload?.model === "string") {
			currentModel = raw.payload.model;
			continue;
		}

		let mapped: TranscriptEntry | null = null;

		if (raw.type === "response_item" && raw.payload?.type === "message") {
			const role = raw.payload.role;
			if (role === "user" || role === "assistant") {
				const textContent = parseCodexMessageText(raw.payload.content);
				mapped = {
					timestamp: raw.timestamp,
					message: {
						role,
						model: currentModel,
						content: textContent,
					},
				};
			}
		} else if (
			raw.type === "response_item" &&
			raw.payload?.type === "function_call" &&
			typeof raw.payload?.name === "string"
		) {
			const args = parseCodexToolArguments(raw.payload.arguments);
			const content: ContentBlock[] = [
				{
					type: "tool_use",
					name: raw.payload.name,
					input: args,
				},
			];
			mapped = {
				timestamp: raw.timestamp,
				message: {
					role: "assistant",
					model: currentModel,
					content,
				},
			};
		} else if (
			raw.type === "response_item" &&
			raw.payload?.type === "function_call_output"
		) {
			mapped = {
				timestamp: raw.timestamp,
				toolUseResult: raw.payload?.output,
			};
		}

		if (!mapped) continue;
		const filtered = filterTranscriptEntry(mapped, privacy);
		if (filtered) yield filtered;
	}
}
