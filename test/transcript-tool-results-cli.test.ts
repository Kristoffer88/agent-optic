import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli", "index.ts");
const temporaryRoots: string[] = [];

const sessionId = "11111111-1111-4111-8111-111111111111";

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
	const root = await mkdtemp(join(tmpdir(), "agent-optic-tool-results-"));
	temporaryRoots.push(root);
	const sessions = join(root, "agent", "sessions", "fixture");
	await mkdir(sessions, { recursive: true });
	await writeFile(join(sessions, `2026-07-15T10-00-00-000Z_${sessionId}.jsonl`), [
		JSON.stringify({ type: "session", timestamp: "2026-07-15T10:00:00.000Z", cwd: "/workspace/repo" }),
		JSON.stringify({
			type: "message",
			timestamp: "2026-07-15T10:00:01.000Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "browser", arguments: { action: "open" } }],
			},
		}),
		JSON.stringify({
			type: "message",
			timestamp: "2026-07-15T10:00:02.000Z",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "browser",
				content: [{ type: "text", text: "connection refused" }],
				isError: true,
			},
		}),
	].join("\n"));
	return root;
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("transcript --include-tool-results", () => {
	test("keeps results hidden by default", async () => {
		const root = await piFixture();
		const result = await runCli([
			"transcript", sessionId, "--provider", "pi", "--provider-dir", root,
			"--format", "jsonl", "--raw",
		]);

		expect(result.exitCode).toBe(0);
		const rows = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
		expect(rows).toHaveLength(1);
		expect(rows[0].message.content[0].id).toBe("call-1");
	});

	test("explicitly exposes correlated result metadata", async () => {
		const root = await piFixture();
		const result = await runCli([
			"transcript", sessionId, "--provider", "pi", "--provider-dir", root,
			"--format", "jsonl", "--raw", "--include-tool-results",
		]);

		expect(result.exitCode).toBe(0);
		const rows = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({
			toolUseResult: "connection refused",
			toolUseId: "call-1",
			toolName: "browser",
			isError: true,
		});
	});

	test("rejects the result flag outside transcript", async () => {
		const result = await runCli(["sessions", "--provider", "pi", "--include-tool-results", "--raw"]);
		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stderr).error.code).toBe("UNSUPPORTED_OPTION");
	});
});
