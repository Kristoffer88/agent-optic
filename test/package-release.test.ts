import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("the 0.6.0 package contains intended validation source but excludes generated receipts", async () => {
	const npm = Bun.which("npm");
	if (!npm) throw new Error("npm is required for the package manifest test");
	const generatedDir = join(root, "evals", "pi-lifecycle", "out");
	const sentinel = join(generatedDir, "package-test-sentinel.json");
	await mkdir(generatedDir, { recursive: true });
	await writeFile(sentinel, "{\"generated\":true}\n", "utf8");

	try {
		const child = Bun.spawn([npm, "pack", "--dry-run", "--json"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (exitCode !== 0) throw new Error(`npm pack --dry-run failed: ${stderr}`);
		const result = JSON.parse(stdout)[0];
		const files = new Set<string>(result.files.map((file: { path: string }) => file.path));

		expect(result.version).toBe("0.6.0");
		expect(files.has("src/collectors/session-observation.ts")).toBeTrue();
		expect(files.has("src/types/observation.ts")).toBeTrue();
		expect(files.has("evals/pi-lifecycle/run.ts")).toBeTrue();
		expect(files.has("evals/pi-lifecycle/README.md")).toBeTrue();
		expect(files.has("CHANGELOG.md")).toBeTrue();
		expect(files.has("SECURITY.md")).toBeTrue();
		expect([...files].some((path) => path.startsWith("evals/pi-lifecycle/out/"))).toBeFalse();
	} finally {
		await rm(sentinel, { force: true });
	}
});
