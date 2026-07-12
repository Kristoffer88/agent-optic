import type { ContentBlock, TranscriptEntry } from "../types/transcript.js";
import type {
	SessionEvidence,
	SessionEvidenceMatch,
	SessionEvidenceOptions,
	SessionEvidencePrompt,
} from "../types/evidence.js";

const DEFAULT_MAX_MATCHES = 8;
const DEFAULT_MAX_CHARS = 4_000;
const DEFAULT_MAX_EXCERPT_CHARS = 320;
const MAX_PROMPTS_PER_EDGE = 2;
const MAX_PATHS = 24;
const MAX_PATH_CANDIDATES = 5_000;
const MAX_TOOL_NAMES = 16;

function cleanText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, maxChars: number): string {
	const text = cleanText(value);
	if (maxChars <= 0) return "";
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function contentBlocks(entry: TranscriptEntry): ContentBlock[] {
	const content = entry.message?.content;
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? content : [];
}

function matchedTerms(text: string, terms: string[]): string[] {
	const lower = text.toLocaleLowerCase();
	return terms.filter((term) => lower.includes(term.toLocaleLowerCase()));
}

function collectStrings(value: unknown, output: string[]): void {
	if (typeof value === "string") {
		output.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectStrings(item, output);
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, output);
}

function pathCandidates(text: string): string[] {
	const candidates = text.match(/(?:~|\.|\/)[A-Za-z0-9_@+.,=~%:/-]+(?:\.[A-Za-z0-9_-]+)?/g) ?? [];
	return candidates
		.map((candidate) => candidate.replace(/[),;'"\]}]+$/g, ""))
		.filter((candidate) => {
			if (candidate.length < 4 || !candidate.includes("/")) return false;
			if (!candidate.startsWith("/")) return true;
			const remainder = candidate.slice(1);
			return remainder.includes("/") || /\.[A-Za-z0-9_-]+$/.test(remainder);
		});
}

function addCount(counts: Map<string, number>, value: string, maxKeys = Number.POSITIVE_INFINITY): void {
	if (!counts.has(value) && counts.size >= maxKeys) return;
	counts.set(value, (counts.get(value) ?? 0) + 1);
}

function rankedKeys(counts: Map<string, number>, limit: number): string[] {
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([value]) => value);
}

function applyCharacterBudget(
	matches: SessionEvidenceMatch[],
	initial: SessionEvidencePrompt[],
	recent: SessionEvidencePrompt[],
	maxChars: number,
): { matches: SessionEvidenceMatch[]; initial: SessionEvidencePrompt[]; recent: SessionEvidencePrompt[]; truncated: boolean } {
	let remaining = maxChars;
	let truncated = false;

	function budget<T extends { excerpt: string }>(items: T[]): T[] {
		const kept: T[] = [];
		for (const item of items) {
			if (remaining <= 0) {
				truncated = true;
				break;
			}
			if (item.excerpt.length <= remaining) {
				kept.push(item);
				remaining -= item.excerpt.length;
				continue;
			}
			kept.push({ ...item, excerpt: clip(item.excerpt, remaining) });
			remaining = 0;
			truncated = true;
		}
		return kept;
	}

	// Query matches carry the strongest retrieval signal. If they exceed the
	// budget, clip every selected match evenly so critical tail evidence survives.
	const matchChars = matches.reduce((sum, item) => sum + item.excerpt.length, 0);
	let keptMatches: SessionEvidenceMatch[];
	if (matches.length > 0 && matchChars > remaining) {
		const perMatch = Math.floor(remaining / matches.length);
		keptMatches = matches.map((item) => ({ ...item, excerpt: clip(item.excerpt, perMatch) }));
		remaining = Math.max(0, remaining - keptMatches.reduce((sum, item) => sum + item.excerpt.length, 0));
		truncated = true;
	} else {
		keptMatches = budget(matches);
	}

	return {
		matches: keptMatches,
		initial: budget(initial),
		recent: budget(recent),
		truncated,
	};
}

/**
 * Scan an exact session transcript and return bounded, cursor-addressable evidence.
 * The scan is complete; only the returned excerpts are bounded.
 */
export async function collectSessionEvidence(
	entries: AsyncIterable<TranscriptEntry>,
	options: SessionEvidenceOptions,
): Promise<SessionEvidence> {
	const terms = [...new Set((options.terms ?? []).map(cleanText).filter(Boolean))];
	const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
	const maxExcerptChars = options.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS;

	const initialPrompts: SessionEvidencePrompt[] = [];
	const recentPrompts: SessionEvidencePrompt[] = [];
	const addPrompt = (prompt: SessionEvidencePrompt) => {
		if (initialPrompts.length < MAX_PROMPTS_PER_EDGE) initialPrompts.push(prompt);
		recentPrompts.push(prompt);
		if (recentPrompts.length > MAX_PROMPTS_PER_EDGE) recentPrompts.shift();
	};
	const boundedMaxMatches = Math.max(1, maxMatches);
	const firstMatchLimit = Math.ceil(boundedMaxMatches / 2);
	const tailMatchLimit = boundedMaxMatches - firstMatchLimit;
	const firstMatches: SessionEvidenceMatch[] = [];
	const tailMatches: SessionEvidenceMatch[] = [];
	let matchCount = 0;
	const addMatch = (match: SessionEvidenceMatch) => {
		matchCount++;
		if (firstMatches.length < firstMatchLimit) {
			firstMatches.push(match);
			return;
		}
		if (tailMatchLimit <= 0) return;
		tailMatches.push(match);
		if (tailMatches.length > tailMatchLimit) tailMatches.shift();
	};
	const pathCounts = new Map<string, number>();
	const toolCounts = new Map<string, number>();
	let entryCount = 0;
	let textBlockCount = 0;
	let toolCallCount = 0;

	for await (const entry of entries) {
		const entryIndex = entryCount++;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;

		const blocks = contentBlocks(entry);
		for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
			const block = blocks[blockIndex];
			if (block.type === "thinking" || block.type === "tool_result") continue;
			const ref = `entry:${entryIndex}/content:${blockIndex}`;

			if (block.type === "tool_use") {
				toolCallCount++;
				if (block.name) addCount(toolCounts, block.name);
				const strings: string[] = [];
				collectStrings(block.input, strings);
				for (const value of strings) {
					for (const path of pathCandidates(value)) addCount(pathCounts, path, MAX_PATH_CANDIDATES);
				}
				const searchable = cleanText(`${block.name ?? "tool"} ${strings.join(" ")}`);
				const hits = matchedTerms(searchable, terms);
				if (hits.length > 0) {
					addMatch({
						ref,
						entry: entryIndex,
						role,
						kind: "tool-call",
						timestamp: entry.timestamp,
						terms: hits,
						excerpt: clip(searchable, maxExcerptChars),
					});
				}
				continue;
			}

			const text = block.text ?? (typeof block.content === "string" ? block.content : "");
			const searchable = cleanText(text);
			if (!searchable) continue;
			textBlockCount++;
			for (const path of pathCandidates(searchable)) addCount(pathCounts, path, MAX_PATH_CANDIDATES);

			if (role === "user") {
				addPrompt({ ref, timestamp: entry.timestamp, excerpt: clip(searchable, maxExcerptChars) });
			}
			const hits = matchedTerms(searchable, terms);
			if (hits.length > 0) {
				addMatch({
					ref,
					entry: entryIndex,
					role,
					kind: "text",
					timestamp: entry.timestamp,
					terms: hits,
					excerpt: clip(searchable, maxExcerptChars),
				});
			}
		}
	}

	const selectedMatches = [...firstMatches, ...tailMatches];
	const budgeted = applyCharacterBudget(selectedMatches, initialPrompts, recentPrompts, Math.max(1, maxChars));

	return {
		schemaVersion: "1.0",
		sessionId: options.sessionId,
		terms,
		scanned: {
			entries: entryCount,
			textBlocks: textBlockCount,
			toolCalls: toolCallCount,
			complete: true,
		},
		prompts: {
			initial: budgeted.initial,
			recent: budgeted.recent,
		},
		footprint: {
			paths: rankedKeys(pathCounts, MAX_PATHS),
			toolNames: rankedKeys(toolCounts, MAX_TOOL_NAMES),
		},
		matches: budgeted.matches,
		truncated: budgeted.truncated || matchCount > selectedMatches.length,
	};
}
