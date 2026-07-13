import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const runner = join(import.meta.dir, "..", "evals", "pi-lifecycle", "run.ts");

test("Pi lifecycle eval writes a comparative privacy receipt", async () => {
	const out = await mkdtemp(join(tmpdir(), "agent-optic-pi-eval-test-"));
	try {
		const process = Bun.spawn([Bun.which("bun")!, runner], {
			env: { ...Bun.env, AGENT_OPTIC_PI_LIFECYCLE_EVAL_OUT: out },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			process.exited,
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
		]);
		if (exitCode !== 0) throw new Error(`eval exited ${exitCode}: ${stderr}`);
		expect(stdout).toMatch(/^PASS 4\/4 cases;/);
		const receiptPath = join(out, "receipt.json");
		const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
		expect(receipt.schemaVersion).toBe("agent-optic-pi-lifecycle-eval-receipt/v1");
		expect(receipt.status).toBe("pass");
		expect(receipt.model).toBeNull();
		expect(receipt.comparison.candidate.passed).toBe(receipt.comparison.candidate.total);
		expect(receipt.comparison.candidate.passed).toBeGreaterThan(receipt.comparison.baseline.passed);
		expect(receipt.results.every((item: { pass: boolean }) => item.pass)).toBeTrue();
		expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
	} finally {
		await rm(out, { recursive: true, force: true });
	}
});
