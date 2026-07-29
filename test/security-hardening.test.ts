import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHistory } from "../src/agent-optic.js";
import { resolvePrivacyConfig } from "../src/privacy/config.js";
import { filterTranscriptEntry } from "../src/privacy/redact.js";
import { resolveClaudeSessionFile } from "../src/readers/session-reader.js";
import { today } from "../src/utils/dates.js";
import { isSafeSessionId } from "../src/utils/paths.js";

const strict = resolvePrivacyConfig("strict");
const assemble = (...segments: string[]): string => segments.join("");
const providerPayload = assemble("abcdEFGH1234567890", "ijklMNOPqrstUVWXyz");

describe("strict credential redaction", () => {
	// Assemble fixtures at runtime so repository secret scanners do not mistake
	// intentionally fake test values for committed credentials.
	const credentialValues = [
		assemble("sk", "-proj-", providerPayload),
		assemble("sk", "-ant-api03-", providerPayload),
		assemble("ey", "JhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTYifQ", ".", "dozjgNryP4J3jVmNHl0w5N"),
		assemble("xox", "b-", "1234567890-abcdefghijklmnop"),
		assemble("AI", "za", "SyA1234567890abcdefghijklmnopqrstuv"),
		assemble("gl", "pat-", "abcdefghij1234567890"),
		assemble("npm", "_", "abcdefghijklmnopqrstuvwxyz0123456789"),
	];
	const credentialLabels = [
		"OpenAI project key",
		"Anthropic key",
		"JWT",
		"Slack token",
		"Google API key",
		"GitLab PAT",
		"npm token",
	];

	for (const [index, secret] of credentialValues.entries()) {
		const label = credentialLabels[index];
		test(`redacts ${label} in message content`, () => {
			const entry = filterTranscriptEntry(
				{ message: { role: "user", content: `here is my token ${secret} keep it safe` } },
				strict,
			);
			// role user under strict is replaced wholesale, so also check a path we know
			// keeps the string: assistant content still runs pattern redaction.
			const assistant = filterTranscriptEntry(
				{ message: { role: "assistant", content: `emitted ${secret} inline` } },
				strict,
			);
			expect(JSON.stringify(assistant)).not.toContain(secret);
			expect(JSON.stringify(entry)).not.toContain(secret);
		});
	}

	test("redacts a PEM private key block", () => {
		const pem =
			"-----BEGIN RSA PRIVATE KEY-----\nMIIBOwIBAAJBAK1234567890\nabcdEFGH\n-----END RSA PRIVATE KEY-----";
		const entry = filterTranscriptEntry(
			{ message: { role: "assistant", content: `key follows: ${pem}` } },
			strict,
		);
		expect(JSON.stringify(entry)).not.toContain("MIIBOwIBAAJBAK");
	});

	test("credential regexes are linear on adversarial input (no ReDoS)", () => {
		const evil = `token=${"a".repeat(50000)}`;
		const start = performance.now();
		filterTranscriptEntry({ message: { role: "assistant", content: evil } }, strict);
		expect(performance.now() - start).toBeLessThan(500);
	});
});

describe("free-text entry-field redaction", () => {
	test("redacts secrets in planContent and error fields under strict", () => {
		const entry = filterTranscriptEntry(
			{
				planContent: `step 1: use ${assemble("sk", "-ant-api03-", providerPayload)}`,
				error: "failed at /Users/example/projects/app/x.ts",
			} as never,
			strict,
		) as Record<string, unknown>;
		expect(JSON.stringify(entry)).not.toContain("sk-ant-api03-abcdEFGH");
		expect(JSON.stringify(entry)).not.toContain("/Users/example");
	});
});

describe("strict auxiliary-data privacy", () => {
	test("hides task, todo, and plan prose", async () => {
		const root = await mkdtemp(join(tmpdir(), "agent-optic-strict-auxiliary-"));
		const date = today();

		try {
			await mkdir(join(root, "tasks", "session-1"), { recursive: true });
			await mkdir(join(root, "todos"), { recursive: true });
			await mkdir(join(root, "plans"), { recursive: true });
			await writeFile(join(root, "tasks", "session-1", "task.json"), JSON.stringify({
				id: "task-1",
				subject: "Private task subject",
				description: "Private task description",
				status: "completed",
			}));
			await writeFile(join(root, "todos", "todo.json"), JSON.stringify({
				id: "todo-1",
				content: "Private todo content",
				status: "pending",
			}));
			await writeFile(join(root, "plans", "plan.md"), "# Private plan title\n\nPrivate plan details\n");

			const history = createHistory({ provider: "claude", providerDir: root, privacy: "strict" });
			const [tasks, todos, plans] = await Promise.all([
				history.tasks.list({ date }),
				history.todos.list({ date }),
				history.plans.list({ date }),
			]);

			expect(tasks[0]).toMatchObject({ subject: "[redacted]", description: "[redacted]" });
			expect(todos[0]?.content).toBe("[redacted]");
			expect(plans[0]).toMatchObject({ title: "[redacted]", snippet: "[redacted]" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("session id path-traversal guard", () => {
	test("isSafeSessionId rejects traversal and glob metacharacters", () => {
		expect(isSafeSessionId("019c9aea-484d-7200-87fd-07a545276ac4")).toBe(true);
		expect(isSafeSessionId("../../etc/passwd")).toBe(false);
		expect(isSafeSessionId("..")).toBe(false);
		expect(isSafeSessionId("a/b")).toBe(false);
		expect(isSafeSessionId("a\\b")).toBe(false);
		expect(isSafeSessionId("a\0b")).toBe(false);
		expect(isSafeSessionId("sess*")).toBe(false);
		expect(isSafeSessionId("@(session)")).toBe(false);
		expect(isSafeSessionId("session name")).toBe(false);
		expect(isSafeSessionId("")).toBe(false);
		expect(isSafeSessionId("x".repeat(200))).toBe(false);
	});

	test("resolveClaudeSessionFile refuses a traversal session id", async () => {
		const resolved = await resolveClaudeSessionFile(
			"/tmp/does-not-matter",
			"/tmp/some/project",
			"../../../../etc/hosts",
		);
		expect(resolved).toBeUndefined();
	});
});
