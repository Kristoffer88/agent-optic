export type EvidenceRole = "user" | "assistant";
export type EvidenceKind = "text" | "tool-call";

export interface SessionEvidenceMatch {
	ref: string;
	entry: number;
	role: EvidenceRole;
	kind: EvidenceKind;
	timestamp?: string;
	terms: string[];
	excerpt: string;
}

export interface SessionEvidencePrompt {
	ref: string;
	timestamp?: string;
	excerpt: string;
}

export interface SessionEvidence {
	schemaVersion: "1.0";
	sessionId: string;
	terms: string[];
	scanned: {
		entries: number;
		textBlocks: number;
		toolCalls: number;
		complete: true;
	};
	prompts: {
		initial: SessionEvidencePrompt[];
		recent: SessionEvidencePrompt[];
	};
	footprint: {
		paths: string[];
		toolNames: string[];
	};
	matches: SessionEvidenceMatch[];
	truncated: boolean;
}

export interface SessionEvidenceOptions {
	sessionId: string;
	terms?: string[];
	maxMatches?: number;
	maxChars?: number;
	maxExcerptChars?: number;
}
