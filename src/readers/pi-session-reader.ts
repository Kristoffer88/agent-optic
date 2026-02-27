import { join } from "node:path";
import type { PrivacyConfig } from "../types/privacy.js";
import type { SessionDetail, SessionInfo, SessionMeta, ToolCallSummary } from "../types/session.js";
import type { ContentBlock, TranscriptEntry } from "../types/transcript.js";
import { toLocalDate } from "../utils/dates.js";
import { decodePiProjectPath, projectName } from "../utils/paths.js";
import { isProjectExcluded, redactString, filterTranscriptEntry } from "../privacy/redact.js";
import { extractText, extractFilePaths, countThinkingBlocks } from "../parsers/content-blocks.js";
import { categorizeToolName, toolDisplayName } from "../parsers/tool-categories.js";

// Pi filenames: {ISO-timestamp}_{uuid}.jsonl
// e.g. 2026-02-05T20-05-58-927Z_05f61a6d-20f8-4c57-917b-df7906fe952f.jsonl
function parsePiFilename(
	filename: string,
): { date: string; sessionId: string; timestamp: string } | null {
	const m = filename.match(
		/^(\d{4}-\d{2}-\d{2})T[\d-]+Z_([0-9a-f-]{36})\.jsonl$/,
	);
	return m ? { date: m[1], sessionId: m[2], timestamp: m[1] } : null;
}

const piIndexCache = new Map<string, Promise<Map<string, string>>>();

async function buildPiIndex(sessionsDir: string): Promise<Map<string, string>> {
	const index = new Map<string, string>();
	const glob = new Bun.Glob("**/*.jsonl");
	for await (const path of glob.scan({ cwd: sessionsDir, absolute: false })) {
		const filename = path.split("/").pop()!;
		const parsed = parsePiFilename(filename);
		if (parsed) index.set(parsed.sessionId, join(sessionsDir, path));
	}
	return index;
}

async function getPiIndex(sessionsDir: string): Promise<Map<string, string>> {
	let promise = piIndexCache.get(sessionsDir);
	if (!promise) {
		promise = buildPiIndex(sessionsDir);
		piIndexCache.set(sessionsDir, promise);
	}
	return promise;
}

/** Find a Pi session file by session ID. */
export async function findPiSessionFile(
	sessionsDir: string,
	sessionId: string,
): Promise<string | null> {
	const index = await getPiIndex(sessionsDir);
	const cached = index.get(sessionId);
	if (cached) return cached;

	// Fallback for newly created files
	const glob = new Bun.Glob(`**/*_${sessionId}.jsonl`);
	for await (const path of glob.scan({ cwd: sessionsDir, absolute: false })) {
		const fullPath = join(sessionsDir, path);
		index.set(sessionId, fullPath);
		return fullPath;
	}
	return null;
}

/** Read all Pi sessions by scanning directory tree (no history.jsonl). */
export async function readPiHistory(
	sessionsDir: string,
	from: string,
	to: string,
	privacy: PrivacyConfig,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	const glob = new Bun.Glob("**/*.jsonl");

	for await (const path of glob.scan({ cwd: sessionsDir, absolute: false })) {
		const filename = path.split("/").pop()!;
		const parsed = parsePiFilename(filename);
		if (!parsed) continue;

		// Filter by date from filename before reading file
		if (parsed.date < from || parsed.date > to) continue;

		const fullPath = join(sessionsDir, path);
		const file = Bun.file(fullPath);
		if (!(await file.exists())) continue;

		let cwd: string | undefined;
		let firstPrompt: string | undefined;
		let sessionTimestamp: number | undefined;

		try {
			const text = await file.text();
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				let entry: any;
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}

				if (entry.type === "session") {
					cwd = entry.cwd;
					sessionTimestamp = new Date(entry.timestamp).getTime();
				}

				if (
					entry.type === "message" &&
					entry.message?.role === "user" &&
					!firstPrompt
				) {
					const content = entry.message.content;
					if (typeof content === "string") {
						firstPrompt = content;
					} else if (Array.isArray(content)) {
						const textBlock = content.find(
							(b: any) => b.type === "text" && typeof b.text === "string",
						);
						if (textBlock) firstPrompt = textBlock.text;
					}
				}

				if (cwd && firstPrompt) break;
			}
		} catch {
			continue;
		}

		if (!cwd) continue;
		if (isProjectExcluded(cwd, privacy)) continue;

		const ts = sessionTimestamp ?? new Date(parsed.date).getTime();
		const prompt = firstPrompt
			? privacy.redactPrompts
				? "[redacted]"
				: privacy.redactPatterns.length > 0
					? redactString(firstPrompt, privacy)
					: firstPrompt
			: "(no prompt)";

		sessions.push({
			sessionId: parsed.sessionId,
			project: cwd,
			projectName: projectName(cwd),
			prompts: [prompt],
			promptTimestamps: [ts],
			timeRange: { start: ts, end: ts },
		});
	}

	sessions.sort((a, b) => a.timeRange.start - b.timeRange.start);
	return sessions;
}

/** Peek Pi session metadata (model, tokens, cost). */
export async function peekPiSession(
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

	const filePath = await findPiSessionFile(sessionsDir, session.sessionId);
	if (!filePath) return meta;

	const file = Bun.file(filePath);
	if (!(await file.exists())) return meta;

	let totalCost = 0;

	try {
		const text = await file.text();
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}

			if (entry.type === "model_change") {
				if (!meta.model && typeof entry.modelId === "string") {
					meta.model = entry.modelId;
				}
			}

			if (entry.type === "message" && entry.message) {
				const msg = entry.message;

				if (msg.role === "user" || msg.role === "assistant") {
					meta.messageCount++;
				}

				if (msg.usage && typeof msg.usage === "object") {
					meta.totalInputTokens += Number(msg.usage.input ?? 0);
					meta.totalOutputTokens += Number(msg.usage.output ?? 0);
					meta.cacheReadInputTokens += Number(msg.usage.cacheRead ?? 0);
					meta.cacheCreationInputTokens += Number(msg.usage.cacheWrite ?? 0);
				}

				if (msg.usage?.cost && typeof msg.usage.cost.total === "number") {
					totalCost += msg.usage.cost.total;
				}
			}
		}
	} catch {
		// file unreadable
	}

	if (totalCost > 0) meta.totalCost = totalCost;
	return meta;
}

/** Parse full Pi session detail. */
export async function parsePiSessionDetail(
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

	const filePath = await findPiSessionFile(sessionsDir, session.sessionId);
	if (!filePath) return detail;

	const file = Bun.file(filePath);
	if (!(await file.exists())) return detail;

	const toolCallSet = new Map<string, ToolCallSummary>();
	const fileSet = new Set<string>();
	let model: string | undefined;
	let totalCost = 0;

	try {
		const text = await file.text();
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}

			if (entry.type === "model_change") {
				if (!model && typeof entry.modelId === "string") {
					model = entry.modelId;
				}
			}

			if (entry.type !== "message" || !entry.message) continue;
			const msg = entry.message;

			if (msg.role === "user" || msg.role === "assistant") {
				detail.messageCount++;
			}

			if (msg.usage && typeof msg.usage === "object") {
				detail.totalInputTokens += Number(msg.usage.input ?? 0);
				detail.totalOutputTokens += Number(msg.usage.output ?? 0);
				detail.cacheReadInputTokens += Number(msg.usage.cacheRead ?? 0);
				detail.cacheCreationInputTokens += Number(msg.usage.cacheWrite ?? 0);
			}

			if (msg.usage?.cost && typeof msg.usage.cost.total === "number") {
				totalCost += msg.usage.cost.total;
			}

			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				// Map Pi content blocks to our ContentBlock format for extraction
				const blocks: ContentBlock[] = [];
				for (const block of msg.content) {
					if (block.type === "text" && typeof block.text === "string") {
						blocks.push({ type: "text", text: block.text });
					} else if (block.type === "thinking" && typeof block.thinking === "string") {
						blocks.push({ type: "thinking", thinking: block.thinking });
					} else if (block.type === "toolCall" && typeof block.name === "string") {
						const input = block.arguments && typeof block.arguments === "object"
							? block.arguments
							: undefined;
						blocks.push({ type: "tool_use", name: block.name, input });

						const displayName = toolDisplayName(block.name, input);
						const target = extractPiToolTarget(block.name, input);
						toolCallSet.set(displayName, {
							name: block.name,
							displayName,
							category: categorizeToolName(block.name),
							target,
						});

						const fp = extractPiFilePath(input);
						if (fp) fileSet.add(fp);
					}
				}

				const textContent = extractText(blocks);
				if (textContent && textContent.length > 20) {
					const redacted =
						privacy.redactPatterns.length > 0 || privacy.redactHomeDir
							? redactString(textContent, privacy)
							: textContent;
					detail.assistantSummaries.push(
						redacted.slice(0, 200) + (redacted.length > 200 ? "..." : ""),
					);
				}

				for (const fp of extractFilePaths(blocks)) {
					fileSet.add(fp);
				}

				detail.thinkingBlockCount += countThinkingBlocks(blocks);
			}
		}
	} catch {
		// file unreadable
	}

	detail.toolCalls = [...toolCallSet.values()];
	detail.filesReferenced = [...fileSet];
	detail.model = model;
	if (totalCost > 0) detail.totalCost = totalCost;
	detail.assistantSummaries = detail.assistantSummaries.slice(0, 10);
	return detail;
}

/** Stream Pi transcript entries with privacy filtering. */
export async function* streamPiTranscript(
	sessionId: string,
	sessionsDir: string,
	privacy: PrivacyConfig,
): AsyncGenerator<TranscriptEntry> {
	const filePath = await findPiSessionFile(sessionsDir, sessionId);
	if (!filePath) return;

	const file = Bun.file(filePath);
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

		if (raw.type === "model_change" && typeof raw.modelId === "string") {
			currentModel = raw.modelId;
			continue;
		}

		// Skip non-message events
		if (raw.type !== "message" || !raw.message) continue;

		const msg = raw.message;
		let mapped: TranscriptEntry | null = null;

		if (msg.role === "user") {
			const content = Array.isArray(msg.content)
				? msg.content
						.filter((b: any) => b.type === "text" && typeof b.text === "string")
						.map((b: any) => b.text)
						.join("\n")
				: typeof msg.content === "string"
					? msg.content
					: "";
			mapped = {
				timestamp: raw.timestamp,
				message: { role: "user", content },
			};
		} else if (msg.role === "assistant" && Array.isArray(msg.content)) {
			const blocks: ContentBlock[] = [];
			for (const block of msg.content) {
				if (block.type === "text" && typeof block.text === "string") {
					blocks.push({ type: "text", text: block.text });
				} else if (block.type === "thinking" && typeof block.thinking === "string") {
					// Strip signature
					blocks.push({ type: "thinking", thinking: block.thinking });
				} else if (block.type === "toolCall" && typeof block.name === "string") {
					const input = block.arguments && typeof block.arguments === "object"
						? block.arguments
						: undefined;
					blocks.push({ type: "tool_use", name: block.name, id: block.id, input });
				}
			}
			mapped = {
				timestamp: raw.timestamp,
				message: {
					role: "assistant",
					model: currentModel ?? msg.model,
					content: blocks,
					usage: msg.usage
						? {
								input_tokens: msg.usage.input,
								output_tokens: msg.usage.output,
								cache_read_input_tokens: msg.usage.cacheRead,
								cache_creation_input_tokens: msg.usage.cacheWrite,
							}
						: undefined,
				},
			};
		} else if (msg.role === "toolResult") {
			const output = Array.isArray(msg.content)
				? msg.content
						.filter((b: any) => b.type === "text" && typeof b.text === "string")
						.map((b: any) => b.text)
						.join("\n")
				: typeof msg.content === "string"
					? msg.content
					: undefined;
			mapped = {
				timestamp: raw.timestamp,
				toolUseResult: output,
			};
		}

		if (!mapped) continue;
		const filtered = filterTranscriptEntry(mapped, privacy);
		if (filtered) yield filtered;
	}
}

function extractPiFilePath(input: Record<string, unknown> | undefined): string | undefined {
	if (!input) return undefined;
	for (const key of ["file_path", "path", "target_file", "notebook_path"]) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function extractPiToolTarget(
	name: string,
	input: Record<string, unknown> | undefined,
): string | undefined {
	const filePath = extractPiFilePath(input);
	if (filePath) return filePath;
	if (!input) return undefined;
	for (const key of ["command", "pattern", "query"]) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) {
			return key === "command" ? value.split(" ")[0] : value;
		}
	}
	return undefined;
}
