import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli", "index.ts");
const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runCli(args: string[]) {
	const child = Bun.spawn([Bun.which("bun")!, cli, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function piFixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "agent-optic-observe-cli-"));
	temporaryRoots.push(root);
	const sessions = join(root, "agent", "sessions");
	await mkdir(sessions, { recursive: true });
	const sessionId = "11111111-1111-4111-8111-111111111111";
	await writeFile(join(sessions, `2026-01-02T10-00-00-000Z_${sessionId}.jsonl`), [
		JSON.stringify({ type: "session", timestamp: "2026-01-02T10:00:00.000Z", cwd: "/workspace/historical" }),
		JSON.stringify({ type: "message", timestamp: "2026-01-02T10:00:01.000Z", message: { role: "user", content: "Historical prompt" } }),
	].join("\n"));
	return root;
}

describe("observe CLI", () => {
	test("uses --provider as one provider and forwards an exact historical date", async () => {
		const root = await piFixture();
		const result = await runCli([
			"observe", "--provider", "pi", "--provider-dir", root,
			"--date", "2026-01-02", "--raw",
		]);

		expect(result.exitCode).toBe(0);
		const observation = JSON.parse(result.stdout);
		expect(observation.query.providers).toEqual(["pi"]);
		expect(observation.query.date).toBe("2026-01-02");
		expect(observation.sessions.map((session: { sessionId: string }) => session.sessionId))
			.toEqual(["11111111-1111-4111-8111-111111111111"]);
	});

	test("rejects a provider directory for the default multi-provider observation", async () => {
		const root = await piFixture();
		const result = await runCli(["observe", "--provider-dir", root, "--raw"]);

		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stderr).error.code).toBe("UNSUPPORTED_OPTION");
	});

	test("rejects an empty provider list as a CLI validation error", async () => {
		const result = await runCli(["observe", "--providers", ",", "--raw"]);

		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stderr).error.code).toBe("INVALID_PROVIDER");
	});

	test("canonicalizes openai and codex to one provider scan", async () => {
		const root = await mkdtemp(join(tmpdir(), "agent-optic-observe-codex-"));
		temporaryRoots.push(root);
		await mkdir(join(root, "sessions"), { recursive: true });
		const result = await runCli([
			"observe", "--providers", "openai,codex", "--provider-dir", root, "--raw",
		]);

		expect(result.exitCode).toBe(0);
		const observation = JSON.parse(result.stdout);
		expect(observation.query.providers).toEqual(["codex"]);
		expect(observation.providers.map((provider: { provider: string }) => provider.provider)).toEqual(["codex"]);
	});

	test("preserves the legacy evidence-limit error code", async () => {
		const result = await runCli(["evidence", "session-id", "--max-chars", "0"]);

		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stderr).error.code).toBe("INVALID_EVIDENCE_LIMIT");
	});
});
