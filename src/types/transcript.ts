/** A single content block inside an assistant message. */
export interface ContentBlock {
	type: "text" | "thinking" | "tool_use" | "tool_result";
	text?: string;
	thinking?: string;
	name?: string;
	id?: string;
	tool_use_id?: string;
	/** Provider-native tool-result failure flag (Claude-style content blocks). */
	is_error?: boolean;
	/** Normalized/camel-case tool-result failure flag when supplied by a reader. */
	isError?: boolean;
	input?: Record<string, unknown>;
	content?: string | ContentBlock[];
}

/** Raw line from a session JSONL file. Union of all possible shapes. */
export interface TranscriptEntry {
	type?: "user" | "assistant" | "progress" | "file-history-snapshot";
	subtype?: "turn_duration" | string;
	message?: {
		role?: "user" | "assistant";
		content?: string | ContentBlock[];
		model?: string;
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_creation_input_tokens?: number;
			cache_read_input_tokens?: number;
		};
	};
	timestamp?: string;
	gitBranch?: string;
	planContent?: string;
	cwd?: string;
	sessionId?: string;
	isSidechain?: boolean;
	parentUuid?: string;
	uuid?: string;
	toolUseResult?: unknown;
	/** Tool-call identifier carried by a tool result or provider-native call event. */
	toolUseId?: string;
	/** Tool name carried by a provider-native tool result. */
	toolName?: string;
	/** Authoritative provider/runtime failure flag when available. */
	isError?: boolean;
	/** Metadata-only entry (e.g. image paste) — no real message content */
	isMeta?: boolean;
	/** Wall-clock duration of this turn in milliseconds */
	durationMs?: number;
	/** Error message from API failures */
	error?: string;
	/** Whether this entry represents an API error (rate limit, prompt too long, etc.) */
	isApiErrorMessage?: boolean;
	/** Claude Code version string */
	version?: string;
	/** Human-readable session name */
	slug?: string;
	/** Subagent identifier */
	agentId?: string;
	/** User type, e.g. "external" */
	userType?: string;
}
