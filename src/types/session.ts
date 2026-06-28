/** One line from history.jsonl — a single user prompt. */
export interface HistoryEntry {
	display: string;
	timestamp: number;
	project: string;
	sessionId: string;
	pastedContents?: Record<string, unknown>;
}

/** Lightweight session info derived from history.jsonl grouping only. Fast — no file reads. */
export interface SessionInfo {
	sessionId: string;
	project: string;
	projectName: string;
	prompts: string[];
	promptTimestamps: number[];
	timeRange: { start: number; end: number };
	/** Transcript/session file mtime in epoch ms when available. Useful for active-session discovery. */
	lastFileActivity?: number;
	/** How complete the local provider data is for this session. Omitted means full/legacy provider behavior. */
	dataCompleteness?: "full" | "prompt-only" | "metadata-only";
	/** Machine-readable hints for what downstream tools can safely expect. */
	sourceCapabilities?: SourceCapability[];
}

/** Session with metadata peeked from the session JSONL file (first+last lines). */
export interface SessionMeta extends SessionInfo {
	gitBranch?: string;
	model?: string;
	totalInputTokens: number;
	totalOutputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
	messageCount: number;
	totalCost?: number;
}

/** Full session detail from parsing the entire session JSONL file. */
export interface SessionDetail extends SessionMeta {
	assistantSummaries: string[];
	toolCalls: ToolCallSummary[];
	filesReferenced: string[];
	planReferenced: boolean;
	thinkingBlockCount: number;
	hasSidechains: boolean;
}

export type SourceCapability =
	| "prompt"
	| "transcript"
	| "assistant-summary"
	| "tool-calls"
	| "files-referenced"
	| "tokens"
	| "cost"
	| "model"
	| "project"
	| "timestamps";

export type ToolCategory =
	| "file_read"
	| "file_write"
	| "shell"
	| "search"
	| "web"
	| "task"
	| "other";

export interface ToolCallSummary {
	name: string;
	displayName: string;
	category: ToolCategory;
	/** e.g. file_path for Read/Write, command for Bash */
	target?: string;
}
