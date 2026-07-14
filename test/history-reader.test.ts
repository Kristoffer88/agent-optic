import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePrivacyConfig } from "../src/privacy/config.js";
import { readHistory } from "../src/readers/history-reader.js";

const privacy = resolvePrivacyConfig("local");

describe("Claude history discovery", () => {
	test("keeps history-backed sessions and discovers only transcripts missing from history", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agent-optic-history-"));
		const projectsDir = join(dir, "projects", "workspace");
		const historyFile = join(dir, "history.jsonl");
		const knownSessionId = "known-session";
		const fallbackSessionId = "fallback-session";

		try {
			await mkdir(projectsDir, { recursive: true });
			await writeFile(historyFile, JSON.stringify({
				display: "history prompt",
				timestamp: Date.parse("2026-07-14T10:00:00.000Z"),
				project: "/workspace/known",
				sessionId: knownSessionId,
			}) + "\n");
			await writeFile(join(projectsDir, `${knownSessionId}.jsonl`), JSON.stringify({
				type: "user",
				timestamp: "2026-07-14T10:01:00.000Z",
				cwd: "/workspace/known",
				message: { role: "user", content: "discarded transcript prompt" },
			}) + "\n");
			await writeFile(join(projectsDir, `${fallbackSessionId}.jsonl`), JSON.stringify({
				type: "user",
				timestamp: "2026-07-14T11:00:00.000Z",
				cwd: "/workspace/fallback",
				message: { role: "user", content: "fallback prompt" },
			}) + "\n");

			const sessions = await readHistory(
				historyFile,
				"2026-07-14",
				"2026-07-14",
				privacy,
			);

			expect(sessions.map((session) => session.sessionId)).toEqual([
				knownSessionId,
				fallbackSessionId,
			]);
			expect(sessions[0].prompts).toEqual(["history prompt"]);
			expect(sessions[1].prompts).toEqual(["fallback prompt"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
