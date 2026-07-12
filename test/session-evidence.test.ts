import { describe, expect, test } from "bun:test";
import { collectSessionEvidence } from "../src/collectors/session-evidence.js";
import { filterTranscriptEntry } from "../src/privacy/redact.js";
import { resolvePrivacyConfig } from "../src/privacy/config.js";
import type { TranscriptEntry } from "../src/types/transcript.js";

async function* transcript(entries: TranscriptEntry[]): AsyncGenerator<TranscriptEntry> {
	for (const entry of entries) yield entry;
}

function message(role: "user" | "assistant", text: string, timestamp?: string): TranscriptEntry {
	return { timestamp, message: { role, content: [{ type: "text", text }] } };
}

describe("collectSessionEvidence", () => {
	test("scans the complete transcript and keeps middle tool evidence plus critical tail evidence", async () => {
		const entries: TranscriptEntry[] = [
			message("user", "Find the Sample Dashboard session", "2026-07-11T20:00:00Z"),
			message("assistant", "Looking for it"),
			{
				message: {
					role: "assistant",
					content: [{
						type: "tool_use",
						name: "write",
						input: {
							path: "/Users/kristoffer/projects/example/sample-journal/view/sample-dashboard.js",
							content: "Register Sample Dashboard in Example App app navigation",
						},
					}],
				},
			},
			...Array.from({ length: 20 }, (_, index) => message("assistant", `noise ${index}`)),
			message("assistant", "Sample Dashboard remains one of the small apps inside Example App."),
			message("user", "Ship it", "2026-07-11T21:00:00Z"),
		];

		const evidence = await collectSessionEvidence(transcript(entries), {
			sessionId: "session-1",
			terms: ["Sample Dashboard", "Example App"],
			maxMatches: 3,
			maxChars: 2_000,
		});

		expect(evidence.scanned.entries).toBe(entries.length);
		expect(evidence.scanned.complete).toBe(true);
		expect(evidence.matches.some((match) => match.kind === "tool-call" && match.terms.includes("Example App"))).toBe(true);
		expect(evidence.matches.at(-1)?.excerpt).toContain("small apps inside Example App");
		expect(evidence.footprint.paths).toContain("/Users/kristoffer/projects/example/sample-journal/view/sample-dashboard.js");
		expect(evidence.prompts.initial[0]?.excerpt).toBe("Find the Sample Dashboard session");
		expect(evidence.prompts.recent.at(-1)?.excerpt).toBe("Ship it");
	});

	test("bounds excerpts while reporting omitted matching evidence", async () => {
		const entries = Array.from({ length: 12 }, (_, index) =>
			message("assistant", `Sample Dashboard evidence ${index} ${"x".repeat(200)}`),
		);
		const evidence = await collectSessionEvidence(transcript(entries), {
			sessionId: "session-2",
			terms: ["Sample Dashboard"],
			maxMatches: 4,
			maxChars: 180,
			maxExcerptChars: 100,
		});

		expect(evidence.matches).toHaveLength(4);
		expect(evidence.matches[0]?.entry).toBe(0);
		expect(evidence.matches.at(-1)?.entry).toBe(11);
		expect(evidence.matches.reduce((sum, match) => sum + match.excerpt.length, 0)).toBeLessThanOrEqual(180);
		expect(evidence.truncated).toBe(true);
	});
});

describe("shareable transcript privacy", () => {
	test("redacts paths inside tool inputs before evidence collection", () => {
		const filtered = filterTranscriptEntry({
			message: {
				role: "assistant",
				content: [{
					type: "tool_use",
					name: "read",
					input: { path: "/Users/kristoffer/projects/private/file.txt" },
				}],
			},
		}, resolvePrivacyConfig("shareable"));

		const block = filtered?.message?.content;
		expect(Array.isArray(block) ? block[0]?.input?.path : undefined).toBe("~/projects/private/file.txt");
	});
});
