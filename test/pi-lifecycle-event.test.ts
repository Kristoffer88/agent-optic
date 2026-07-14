import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePrivacyConfig } from "../src/privacy/config.js";
import { readPiHistory } from "../src/readers/pi-session-reader.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(lines: unknown[], sessionId: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "agent-optic-pi-lifecycle-"));
	temporaryRoots.push(root);
	const file = join(root, `2026-07-13T10-00-00-000Z_${sessionId}.jsonl`);
	await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
	return root;
}

describe("Pi lifecycle evidence", () => {
	test("exposes a final assistant stop without transcript content", async () => {
		const sessionId = "11111111-1111-4111-8111-111111111111";
		const root = await fixture([
			{ type: "session", timestamp: "2026-07-13T10:00:00.000Z", cwd: "/workspace/example" },
			{ type: "message", timestamp: "2026-07-13T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Do the bounded task" }] } },
			{ type: "message", timestamp: "2026-07-13T10:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" } },
		], sessionId);

		const sessions = await readPiHistory(root, "2026-07-13", "2026-07-13", resolvePrivacyConfig("shareable"));
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.lastMessageRole).toBe("assistant");
		expect(sessions[0]?.lastMessageStopReason).toBe("stop");
		expect(sessions[0]?.lastMessageTimestamp).toBe(Date.parse("2026-07-13T10:00:05.000Z"));
		expect(sessions[0]?.sourceCapabilities).toContain("lifecycle-event");
	});

	test("reports a tool result as the latest in-progress event", async () => {
		const sessionId = "22222222-2222-4222-8222-222222222222";
		const root = await fixture([
			{ type: "session", timestamp: "2026-07-13T10:00:00.000Z", cwd: "/workspace/example" },
			{ type: "message", timestamp: "2026-07-13T10:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }], stopReason: "toolUse" } },
			{ type: "message", timestamp: "2026-07-13T10:00:03.000Z", message: { role: "toolResult", content: [{ type: "text", text: "bounded result" }] } },
		], sessionId);

		const sessions = await readPiHistory(root, "2026-07-13", "2026-07-13", resolvePrivacyConfig("shareable"));
		expect(sessions[0]?.lastMessageRole).toBe("toolResult");
		expect(sessions[0]?.lastMessageStopReason).toBeUndefined();
		expect(sessions[0]?.lastMessageTimestamp).toBe(Date.parse("2026-07-13T10:00:03.000Z"));
	});

	test("ignores unrecognized lifecycle strings instead of exposing them", async () => {
		const sessionId = "33333333-3333-4333-8333-333333333333";
		const root = await fixture([
			{ type: "session", timestamp: "2026-07-13T10:00:00.000Z", cwd: "/workspace/example" },
			{ type: "message", timestamp: "2026-07-13T10:00:02.000Z", message: { role: "assistant", content: [], stopReason: "stop" } },
			{ type: "message", timestamp: "2026-07-13T10:00:03.000Z", message: { role: "token=abcdefghijklmnopqrstuvwx", content: [], stopReason: "secret=abcdefghijklmnopqrstuvwx" } },
		], sessionId);

		const sessions = await readPiHistory(root, "2026-07-13", "2026-07-13", resolvePrivacyConfig("strict"));
		expect(sessions[0]?.lastMessageRole).toBe("assistant");
		expect(sessions[0]?.lastMessageStopReason).toBe("stop");
		expect(JSON.stringify(sessions[0])).not.toContain("abcdefghijklmnopqrstuvwx");
	});
});
