import { homedir } from "node:os";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PrivacyConfig } from "../types/privacy.js";
import type { ProjectInfo } from "../types/project.js";
import type { SessionDetail, SessionInfo, SessionMeta, SourceCapability, ToolCallSummary } from "../types/session.js";
import type { ContentBlock, TranscriptEntry } from "../types/transcript.js";
import { isProjectExcluded, redactString, shouldRedactStrings, filterTranscriptEntry } from "../privacy/redact.js";
import { projectName } from "../utils/paths.js";
import { toLocalDate } from "../utils/dates.js";
import { countThinkingBlocks, extractFilePaths, extractText, extractToolCalls } from "../parsers/content-blocks.js";

interface OpenCodeNotification {
	directory?: string;
	time?: number;
	type?: string;
	session?: string;
}

interface OpenCodeStoredSession {
	id?: string;
	directory?: string;
	title?: string;
	projectID?: string;
	time?: { created?: number; updated?: number };
}

interface OpenCodeMessage {
	id?: string;
	sessionID?: string;
	role?: "user" | "assistant";
	time?: { created?: number; completed?: number };
	modelID?: string;
	providerID?: string;
	path?: { cwd?: string; root?: string };
	cost?: number;
	tokens?: {
		input?: number;
		output?: number;
		reasoning?: number;
		cache?: { read?: number; write?: number };
	};
}

interface OpenCodePart {
	id?: string;
	sessionID?: string;
	messageID?: string;
	type?: string;
	text?: string;
	tool?: string;
	state?: {
		input?: Record<string, unknown>;
		output?: unknown;
		title?: string;
	};
	time?: { start?: number; end?: number };
}

interface OpenCodeSessionRecord {
	sessionId: string;
	project: string;
	start: number;
	end: number;
	eventCount: number;
	model?: string;
	storageDir?: string;
	lastFileActivity?: number;
}

const OPENCODE_METADATA_PROMPT = "(OpenCode metadata-only session; prompt text is not available locally)";
const openCodeRecordCache = new Map<string, Promise<OpenCodeSessionRecord[]>>();
const OPENCODE_METADATA_CAPABILITIES = ["model", "project", "timestamps"] as const;
const OPENCODE_TRANSCRIPT_CAPABILITIES = [
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
] as const;

function displayProject(project: string, privacy: PrivacyConfig): string {
	return shouldRedactStrings(privacy) ? redactString(project, privacy) : project;
}

function recordCompleteness(record: OpenCodeSessionRecord): SessionInfo["dataCompleteness"] {
	return record.storageDir ? "full" : "metadata-only";
}

function recordCapabilities(record: OpenCodeSessionRecord): SourceCapability[] {
	return record.storageDir ? [...OPENCODE_TRANSCRIPT_CAPABILITIES] : [...OPENCODE_METADATA_CAPABILITIES];
}

function parseNestedJson<T>(value: unknown): T | undefined {
	if (typeof value !== "string") return undefined;
	try {
		return JSON.parse(value) as T;
	} catch {
		return undefined;
	}
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await Bun.file(path).text()) as T;
	} catch {
		return undefined;
	}
}

async function readDat(path: string): Promise<Record<string, unknown>> {
	return (await readJson<Record<string, unknown>>(path)) ?? {};
}

async function walkJsonFiles(root: string): Promise<string[]> {
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
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile() && entry.name.endsWith(".json")) out.push(path);
		}
	}
	await walk(root);
	return out;
}

async function directoryExists(path: string): Promise<boolean> {
	try {
		await readdir(path);
		return true;
	} catch {
		return false;
	}
}

async function resolveStorageDir(baseDir: string): Promise<string | undefined> {
	const local = join(baseDir, "storage");
	if (await directoryExists(local)) return local;
	const shared = join(homedir(), ".local", "share", "opencode", "storage");
	if (await directoryExists(shared)) return shared;
	return undefined;
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

async function readStorageRecords(baseDir: string, modelSelections: Map<string, string>): Promise<OpenCodeSessionRecord[]> {
	const storageDir = await resolveStorageDir(baseDir);
	if (!storageDir) return [];
	const files = await walkJsonFiles(join(storageDir, "session"));
	const records: OpenCodeSessionRecord[] = [];
	for (const filePath of files) {
		const session = await readJson<OpenCodeStoredSession>(filePath);
		if (!session?.id || !session.time?.created) continue;
		const messages = await readMessages({
			sessionId: session.id,
			project: session.directory ?? `(opencode)/${session.id}`,
			start: session.time.created,
			end: session.time.updated ?? session.time.created,
			eventCount: 0,
			storageDir,
		});
		const model = messages.find((message) => message.modelID)?.modelID;
		records.push({
			sessionId: session.id,
			project: session.directory ?? messages.find((message) => message.path?.cwd)?.path?.cwd ?? `(opencode)/${session.id}`,
			start: session.time.created,
			end: session.time.updated ?? Math.max(session.time.created, ...messages.map((message) => message.time?.completed ?? message.time?.created ?? session.time!.created!)),
			eventCount: messages.length,
			model: modelSelections.get(session.id) ?? (model ? `${messages.find((message) => message.modelID === model)?.providerID ?? "opencode"}/${model}` : undefined),
			storageDir,
			lastFileActivity: Bun.file(filePath).lastModified || undefined,
		});
	}
	return records;
}

async function readNotificationRecords(baseDir: string, modelSelections: Map<string, string>): Promise<OpenCodeSessionRecord[]> {
	const data = await readDat(join(baseDir, "opencode.global.dat"));
	const notification = parseNestedJson<{ list?: OpenCodeNotification[] }>(data.notification);
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
			lastFileActivity: Bun.file(join(baseDir, "opencode.global.dat")).lastModified || undefined,
		};
	});
}

async function readRecords(baseDir: string, privacy?: PrivacyConfig): Promise<OpenCodeSessionRecord[]> {
	let promise = openCodeRecordCache.get(baseDir);
	if (!promise) {
		promise = (async () => {
			const modelSelections = await readModelSelections(baseDir);
			const records = await readStorageRecords(baseDir, modelSelections);
			const seen = new Set(records.map((record) => record.sessionId));
			for (const record of await readNotificationRecords(baseDir, modelSelections)) {
				if (!seen.has(record.sessionId)) records.push(record);
			}
			return records.sort((a, b) => a.start - b.start);
		})();
		openCodeRecordCache.set(baseDir, promise);
	}

	const records = await promise;
	return privacy
		? records.filter((record) => !isProjectExcluded(record.project, privacy))
		: records;
}

async function readMessages(record: OpenCodeSessionRecord): Promise<OpenCodeMessage[]> {
	if (!record.storageDir) return [];
	const dir = join(record.storageDir, "message", record.sessionId);
	let files: string[];
	try {
		files = (await readdir(dir)).filter((file) => file.endsWith(".json"));
	} catch {
		return [];
	}
	const messages: OpenCodeMessage[] = [];
	for (const file of files) {
		const message = await readJson<OpenCodeMessage>(join(dir, file));
		if (message?.id) messages.push(message);
	}
	return messages.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
}

async function readParts(record: OpenCodeSessionRecord, messageId: string): Promise<OpenCodePart[]> {
	if (!record.storageDir) return [];
	const dir = join(record.storageDir, "part", messageId);
	let files: string[];
	try {
		files = (await readdir(dir)).filter((file) => file.endsWith(".json"));
	} catch {
		return [];
	}
	const parts: OpenCodePart[] = [];
	for (const file of files) {
		const part = await readJson<OpenCodePart>(join(dir, file));
		if (part?.id) parts.push(part);
	}
	return parts.sort((a, b) => (a.time?.start ?? 0) - (b.time?.start ?? 0));
}

function normalizeToolInput(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!input) return undefined;
	return {
		...input,
		file_path: input.file_path ?? input.filePath,
		notebook_path: input.notebook_path ?? input.notebookPath,
	};
}

function entryUsage(message: OpenCodeMessage): TranscriptEntry["message"] extends { usage?: infer U } ? U : never {
	return {
		input_tokens: message.tokens?.input,
		output_tokens: message.tokens?.output,
		cache_read_input_tokens: message.tokens?.cache?.read,
		cache_creation_input_tokens: message.tokens?.cache?.write,
	} as never;
}

async function buildTranscriptEntry(record: OpenCodeSessionRecord, message: OpenCodeMessage): Promise<TranscriptEntry | undefined> {
	if (!message.id || (message.role !== "user" && message.role !== "assistant")) return undefined;
	const parts = await readParts(record, message.id);
	const text = parts.filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n");
	const toolBlocks: ContentBlock[] = parts
		.filter((part) => part.type === "tool" && part.tool)
		.map((part) => ({
			type: "tool_use" as const,
			id: part.id,
			name: part.tool,
			input: normalizeToolInput(part.state?.input),
		}));
	const textBlocks: ContentBlock[] = text ? [{ type: "text", text }] : [];
	const content = message.role === "assistant" ? [...textBlocks, ...toolBlocks] : text;
	return {
		type: message.role,
		timestamp: new Date(message.time?.created ?? record.start).toISOString(),
		cwd: displayProject(record.project, { redactHomeDir: false, redactAbsolutePaths: false, redactPatterns: [], redactPrompts: false, stripThinking: false, stripToolResults: false, excludeProjects: [] }),
		sessionId: record.sessionId,
		message: {
			role: message.role,
			model: message.modelID ? `${message.providerID ?? "opencode"}/${message.modelID}` : record.model,
			content,
			usage: entryUsage(message),
		},
	};
}

async function readTranscriptEntries(record: OpenCodeSessionRecord, privacy: PrivacyConfig): Promise<TranscriptEntry[]> {
	const entries: TranscriptEntry[] = [];
	for (const message of await readMessages(record)) {
		const entry = await buildTranscriptEntry(record, message);
		if (!entry) continue;
		entry.cwd = displayProject(record.project, privacy);
		const filtered = filterTranscriptEntry(entry, privacy);
		if (filtered) entries.push(filtered);
	}
	return entries;
}

function promptFromEntry(entry: TranscriptEntry, privacy: PrivacyConfig): string | undefined {
	if (entry.message?.role !== "user") return undefined;
	const content = entry.message.content;
	const text = typeof content === "string" ? content : extractText(content);
	if (!text.trim()) return undefined;
	if (privacy.redactPrompts) return "[redacted]";
	return shouldRedactStrings(privacy) ? redactString(text.trim(), privacy) : text.trim();
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
		const transcript = await readTranscriptEntries(record, privacy);
		const prompts = transcript.map((entry) => promptFromEntry(entry, privacy)).filter((value): value is string => Boolean(value));
		const promptTimestamps = transcript
			.filter((entry) => entry.message?.role === "user")
			.map((entry) => entry.timestamp ? Date.parse(entry.timestamp) : record.start)
			.filter((timestamp) => Number.isFinite(timestamp));
		sessions.push({
			sessionId: record.sessionId,
			project,
			projectName: projectName(project),
			prompts: prompts.length > 0 ? prompts : [OPENCODE_METADATA_PROMPT],
			promptTimestamps: promptTimestamps.length > 0 ? promptTimestamps : [record.start],
			timeRange: { start: record.start, end: record.end },
			lastFileActivity: record.lastFileActivity,
			dataCompleteness: recordCompleteness(record),
			sourceCapabilities: recordCapabilities(record),
		});
	}
	return sessions;
}

async function findRecord(baseDir: string, sessionId: string, privacy?: PrivacyConfig): Promise<OpenCodeSessionRecord | undefined> {
	return (await readRecords(baseDir, privacy)).find((record) => record.sessionId === sessionId);
}

export async function peekOpenCodeSession(session: SessionInfo, baseDir: string): Promise<SessionMeta> {
	const record = await findRecord(baseDir, session.sessionId);
	const transcript = record ? await readTranscriptEntries(record, { redactHomeDir: false, redactAbsolutePaths: false, redactPatterns: [], redactPrompts: false, stripThinking: false, stripToolResults: false, excludeProjects: [] }) : [];
	const meta: SessionMeta = {
		...session,
		model: record?.model ?? transcript.find((entry) => entry.message?.model)?.message?.model,
		dataCompleteness: record ? recordCompleteness(record) : session.dataCompleteness,
		sourceCapabilities: record ? recordCapabilities(record) : session.sourceCapabilities,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
		messageCount: transcript.length || record?.eventCount || session.prompts.length,
	};
	for (const entry of transcript) {
		const usage = entry.message?.usage;
		if (!usage) continue;
		meta.totalInputTokens += usage.input_tokens ?? 0;
		meta.totalOutputTokens += usage.output_tokens ?? 0;
		meta.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
		meta.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
	}
	return meta;
}

export async function parseOpenCodeSessionDetail(session: SessionInfo, baseDir: string, privacy: PrivacyConfig): Promise<SessionDetail> {
	const record = await findRecord(baseDir, session.sessionId, privacy);
	const transcript = record ? await readTranscriptEntries(record, privacy) : [];
	const detail: SessionDetail = {
		...session,
		model: record?.model ?? transcript.find((entry) => entry.message?.model)?.message?.model,
		dataCompleteness: record ? recordCompleteness(record) : session.dataCompleteness,
		sourceCapabilities: record ? recordCapabilities(record) : session.sourceCapabilities,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
		messageCount: transcript.length || record?.eventCount || session.prompts.length,
		assistantSummaries: [],
		toolCalls: [],
		filesReferenced: [],
		planReferenced: false,
		thinkingBlockCount: 0,
		hasSidechains: false,
	};

	const toolCallList: ToolCallSummary[] = [];
	const fileSet = new Set<string>();
	for (const entry of transcript) {
		const usage = entry.message?.usage;
		if (usage) {
			detail.totalInputTokens += usage.input_tokens ?? 0;
			detail.totalOutputTokens += usage.output_tokens ?? 0;
			detail.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
			detail.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
		}
		const { role, content } = entry.message ?? {};
		if (role === "assistant" && content) {
			const text = extractText(content);
			if (text && text.length > 20) detail.assistantSummaries.push(text.slice(0, 200) + (text.length > 200 ? "..." : ""));
			for (const toolCall of extractToolCalls(content, privacy)) toolCallList.push(toolCall);
			for (const filePath of extractFilePaths(content, privacy)) fileSet.add(filePath);
			detail.thinkingBlockCount += countThinkingBlocks(content);
		}
	}
	if (detail.assistantSummaries.length === 0 && !record?.storageDir) {
		detail.assistantSummaries = ["OpenCode desktop notification storage exposed timestamped session metadata, not prompt/transcript text."];
	}
	detail.toolCalls = toolCallList;
	detail.filesReferenced = [...fileSet];
	detail.assistantSummaries = detail.assistantSummaries.slice(0, 10);
	return detail;
}

export async function* streamOpenCodeTranscript(sessionId: string, baseDir: string, privacy: PrivacyConfig): AsyncGenerator<TranscriptEntry> {
	const record = await findRecord(baseDir, sessionId, privacy);
	if (!record) return;
	const transcript = await readTranscriptEntries(record, privacy);
	if (transcript.length > 0) {
		for (const entry of transcript) yield entry;
		return;
	}
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
