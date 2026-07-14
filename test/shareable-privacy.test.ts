import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePrivacyConfig } from "../src/privacy/config.js";
import { filterTranscriptEntry } from "../src/privacy/redact.js";
import { readPiHistory } from "../src/readers/pi-session-reader.js";

const shareable = resolvePrivacyConfig("shareable");

describe("shareable privacy", () => {
	test("redacts home-rooted paths in user transcript strings and arrays", () => {
		const stringEntry = filterTranscriptEntry({
			type: "message",
			message: { role: "user", content: "Read /Users/example/projects/private/secret.ts now" },
		}, shareable);
		const arrayEntry = filterTranscriptEntry({
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "Open /Users/example/projects/app/config.json" }] },
		}, shareable);

		expect(JSON.stringify(stringEntry)).not.toContain("/Users/example");
		expect(JSON.stringify(arrayEntry)).not.toContain("/Users/example");
		expect(JSON.stringify(stringEntry)).toContain("private/secret.ts");
		expect(JSON.stringify(arrayEntry)).toContain("app/config.json");
	});

	test("removes the home identity before handling paths that contain spaces", () => {
		const entry = filterTranscriptEntry({
			type: "message",
			message: { role: "user", content: "Read /Users/example/My Projects/private/file.ts now" },
		}, shareable);
		const serialized = JSON.stringify(entry);

		expect(serialized).not.toContain("/Users/example");
		expect(serialized).not.toContain("example/My");
		expect(serialized).toContain("~/My Projects/private/file.ts");
	});

	test("applies path redaction to Pi session-list prompts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agent-optic-privacy-"));
		const sessionId = "11111111-1111-4111-8111-111111111111";
		const file = join(dir, `2026-07-14T10-00-00-000Z_${sessionId}.jsonl`);
		try {
			await writeFile(file, [
				JSON.stringify({ type: "session", timestamp: "2026-07-14T10:00:00.000Z", cwd: "/Users/example/projects/app" }),
				JSON.stringify({ type: "message", timestamp: "2026-07-14T10:00:01.000Z", message: { role: "user", content: "Inspect /Users/example/projects/app/src/index.ts" } }),
			].join("\n"));
			const sessions = await readPiHistory(dir, "2026-07-14", "2026-07-14", shareable);
			expect(sessions).toHaveLength(1);
			expect(sessions[0].prompts[0]).not.toContain("/Users/example");
			expect(sessions[0].prompts[0]).toContain("src/index.ts");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
