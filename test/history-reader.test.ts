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

	test("filters fallback transcript prompts to the requested day", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agent-optic-history-range-"));
		const projectsDir = join(dir, "projects", "workspace");
		const historyFile = join(dir, "history.jsonl");
		const sessionId = "fallback-multiday-session";

		try {
			await mkdir(projectsDir, { recursive: true });
			await writeFile(join(projectsDir, `${sessionId}.jsonl`), [
				{
					type: "user",
					timestamp: "2026-07-14T12:00:00.000Z",
					cwd: "/workspace/fallback",
					message: { role: "user", content: "day one" },
				},
				{
					type: "user",
					timestamp: "2026-07-15T12:00:00.000Z",
					cwd: "/workspace/fallback",
					message: { role: "user", content: "day two" },
				},
			].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

			const sessions = await readHistory(
				historyFile,
				"2026-07-15",
				"2026-07-15",
				privacy,
			);

			expect(sessions).toHaveLength(1);
			expect(sessions[0].prompts).toEqual(["day two"]);
			expect(sessions[0].userPromptCount).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("Pi history date filtering", () => {
	test("does not repeat prompts from a multi-day session on every overlapping day", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agent-optic-pi-history-range-"));
		const sessionsDir = join(dir, "sessions", "workspace");
		const sessionId = "11111111-1111-4111-8111-111111111111";
		const filename = `2026-07-14T12-00-00-000Z_${sessionId}.jsonl`;

		try {
			await mkdir(sessionsDir, { recursive: true });
			await writeFile(join(sessionsDir, filename), [
				{ type: "session", timestamp: "2026-07-14T12:00:00.000Z", cwd: "/workspace/pi" },
				{ type: "message", timestamp: "2026-07-14T12:05:00.000Z", message: { role: "user", content: "day one" } },
				{ type: "message", timestamp: "2026-07-15T12:05:00.000Z", message: { role: "user", content: "day two" } },
				{ type: "message", timestamp: "2026-07-16T12:05:00.000Z", message: { role: "assistant", content: "still active", stopReason: "stop" } },
			].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

			const dayTwo = await readHistory(
				join(dir, "unused-history.jsonl"),
				"2026-07-15",
				"2026-07-15",
				privacy,
				{ provider: "pi", sessionsDir: join(dir, "sessions") },
			);
			expect(dayTwo).toHaveLength(1);
			expect(dayTwo[0].prompts).toEqual(["day two"]);
			expect(dayTwo[0].userPromptCount).toBe(1);

			const noPromptDay = await readHistory(
				join(dir, "unused-history.jsonl"),
				"2026-07-16",
				"2026-07-16",
				privacy,
				{ provider: "pi", sessionsDir: join(dir, "sessions") },
			);
			expect(noPromptDay).toHaveLength(1);
			expect(noPromptDay[0].prompts).toEqual(["(no prompt)"]);
			expect(noPromptDay[0].userPromptCount).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
