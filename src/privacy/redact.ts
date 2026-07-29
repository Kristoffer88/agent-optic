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
		// Remove the home identity first. Matching only the non-space home segment avoids
		// leaking a username when a later directory contains spaces.
		result = result.replace(/\/(?:Users|home)\/[^/\s"',;)}\]]+/g, "~");
		// For ordinary no-space paths, retain only the final two useful segments.
		result = result.replace(/~\/[^\s"',;)}\]]+/g, (match) => {
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
				...(Array.isArray(block.content) ? { content: filterContentBlocks(block.content, config) } : {}),
			});
		} else {
			filtered.push(block);
		}
	}

	return filtered;
}

// Free-text entry fields (outside message.content) that can carry prompt
// fragments, paths, or pasted secrets and so must go through string redaction.
// Identity fields (cwd/project/gitBranch) are intentionally left intact for
// correlation — see SECURITY.md.
const REDACTABLE_ENTRY_FIELDS = ["planContent", "error", "slug", "summary"];

/** Redact known free-text string fields on a transcript entry. */
function redactEntryFields(
	entry: TranscriptEntry,
	config: PrivacyConfig,
): TranscriptEntry {
	if (!shouldRedactStrings(config)) return entry;
	let out = entry;
	for (const field of REDACTABLE_ENTRY_FIELDS) {
		const value = (out as Record<string, unknown>)[field];
		if (typeof value === "string") {
			out = { ...out, [field]: redactString(value, config) };
		}
	}
	return out;
}

/** Filter a transcript entry according to privacy config. Returns null to skip entirely. */
export function filterTranscriptEntry(
	entry: TranscriptEntry,
	config: PrivacyConfig,
): TranscriptEntry | null {
	// Skip toolUseResult entries unless a local caller explicitly opted in.
	if (config.stripToolResults && entry.toolUseResult !== undefined) {
		return null;
	}

	const redactedFields = redactEntryFields(entry, config);
	const filteredEntry = redactedFields.toolUseResult !== undefined && shouldRedactStrings(config)
		? { ...redactedFields, toolUseResult: redactUnknown(redactedFields.toolUseResult, config) }
		: redactedFields;

	if (!filteredEntry.message) return filteredEntry;

	const { role, content } = filteredEntry.message;

	if (config.redactPrompts && role === "user") {
		return {
			...filteredEntry,
			message: { ...filteredEntry.message, content: "[redacted]" },
		};
	}

	if (typeof content === "string" && shouldRedactStrings(config)) {
		return {
			...filteredEntry,
			message: { ...filteredEntry.message, content: redactString(content, config) },
		};
	}

	if (Array.isArray(content)) {
		const filtered = filterContentBlocks(content as ContentBlock[], config);
		return {
			...filteredEntry,
			message: { ...filteredEntry.message, content: filtered },
		};
	}

	return filteredEntry;
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
