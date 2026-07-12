import { homedir } from "node:os";
import type { PrivacyConfig } from "../types/privacy.js";
import type { ContentBlock, TranscriptEntry } from "../types/transcript.js";

const home = homedir();

/** True when any string-level redaction option is active. */
export function shouldRedactStrings(config: PrivacyConfig): boolean {
	return (
		config.redactPatterns.length > 0 ||
		config.redactHomeDir ||
		config.redactAbsolutePaths
	);
}

/** Apply all configured redaction patterns to a string. */
export function redactString(text: string, config: PrivacyConfig): string {
	let result = text;

	if (config.redactHomeDir) {
		result = result.replaceAll(home, "~");
	}

	if (config.redactAbsolutePaths) {
		// Replace absolute paths with just the last 2 segments
		result = result.replace(/\/(?:Users|home)\/[^\s"',;)}\]]+/g, (match) => {
			const parts = match.split("/");
			return parts.length > 2 ? parts.slice(-2).join("/") : match;
		});
	}

	for (const pattern of config.redactPatterns) {
		// Clone the regex to reset lastIndex for global patterns
		const re = new RegExp(pattern.source, pattern.flags);
		result = result.replace(re, "[REDACTED]");
	}

	return result;
}

function redactUnknown(value: unknown, config: PrivacyConfig): unknown {
	if (typeof value === "string") return redactString(value, config);
	if (Array.isArray(value)) return value.map((item) => redactUnknown(item, config));
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, item]) => [
			key,
			redactUnknown(item, config),
		]),
	);
}

/** Filter content blocks according to privacy config. */
function filterContentBlocks(
	blocks: ContentBlock[],
	config: PrivacyConfig,
): ContentBlock[] {
	const filtered: ContentBlock[] = [];

	for (const block of blocks) {
		if (config.stripThinking && block.type === "thinking") continue;
		if (config.stripToolResults && block.type === "tool_result") continue;

		if (shouldRedactStrings(config)) {
			filtered.push({
				...block,
				...(block.text ? { text: redactString(block.text, config) } : {}),
				...(block.input ? { input: redactUnknown(block.input, config) as Record<string, unknown> } : {}),
				...(typeof block.content === "string" ? { content: redactString(block.content, config) } : {}),
			});
		} else {
			filtered.push(block);
		}
	}

	return filtered;
}

/** Filter a transcript entry according to privacy config. Returns null to skip entirely. */
export function filterTranscriptEntry(
	entry: TranscriptEntry,
	config: PrivacyConfig,
): TranscriptEntry | null {
	// Skip toolUseResult entries
	if (config.stripToolResults && entry.toolUseResult !== undefined) {
		return null;
	}

	if (!entry.message) return entry;

	const { role, content } = entry.message;

	// Redact user prompts
	if (config.redactPrompts && role === "user") {
		if (typeof content === "string") {
			return {
				...entry,
				message: { ...entry.message, content: "[redacted]" },
			};
		}
	}

	// Filter assistant content blocks
	if (role === "assistant" && Array.isArray(content)) {
		const filtered = filterContentBlocks(content as ContentBlock[], config);
		return {
			...entry,
			message: { ...entry.message, content: filtered },
		};
	}

	return entry;
}

/** Check if a project should be excluded. */
export function isProjectExcluded(
	projectPath: string,
	config: PrivacyConfig,
): boolean {
	if (config.excludeProjects.length === 0) return false;
	const lower = projectPath.toLowerCase();
	return config.excludeProjects.some(
		(p) => lower.includes(p.toLowerCase()),
	);
}
