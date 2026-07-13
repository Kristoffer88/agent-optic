#!/usr/bin/env bun
import { isDeepStrictEqual } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readPiHistory } from "../../src/readers/pi-session-reader.js";
import { resolvePrivacyConfig } from "../../src/privacy/config.js";

const outDir = resolve(process.env.AGENT_OPTIC_PI_LIFECYCLE_EVAL_OUT || join(import.meta.dir, "out"));
const receiptPath = join(outDir, "receipt.json");
const startedAt = new Date();
const root = await mkdtemp(join(tmpdir(), "agent-optic-pi-lifecycle-eval-"));

const definitions = [
	{
		id: "assistant-stop",
		intent: "Expose that the latest assistant turn completed without exposing assistant text.",
		sessionId: "11111111-1111-4111-8111-111111111111",
		lines: [
			{ type: "session", timestamp: "2026-07-13T10:00:00.000Z", cwd: "/workspace/private-project" },
			{ type: "message", timestamp: "2026-07-13T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Private current task" }] } },
			{ type: "message", timestamp: "2026-07-13T10:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "Private completed answer" }], stopReason: "stop" } }
		],
		expected: { role: "assistant", stopReason: "stop", timestamp: Date.parse("2026-07-13T10:00:05.000Z") }
	},
	{
		id: "tool-result",
		intent: "Expose the latest tool result as an in-progress event without retaining its payload.",
		sessionId: "22222222-2222-4222-8222-222222222222",
		lines: [
			{ type: "session", timestamp: "2026-07-13T10:01:00.000Z", cwd: "/workspace/private-project" },
			{ type: "message", timestamp: "2026-07-13T10:01:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }], stopReason: "toolUse" } },
			{ type: "message", timestamp: "2026-07-13T10:01:03.000Z", message: { role: "toolResult", content: [{ type: "text", text: "Private tool payload" }] } }
		],
		expected: { role: "toolResult", stopReason: null, timestamp: Date.parse("2026-07-13T10:01:03.000Z") }
	},
	{
		id: "malformed-tail",
		intent: "Keep the latest valid lifecycle event when a partial trailing JSONL record exists.",
		sessionId: "33333333-3333-4333-8333-333333333333",
		lines: [
			{ type: "session", timestamp: "2026-07-13T10:02:00.000Z", cwd: "/workspace/private-project" },
			{ type: "message", timestamp: "2026-07-13T10:02:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }], stopReason: "toolUse" } }
		],
		trailingRaw: "{partial-jsonl-record",
		expected: { role: "assistant", stopReason: "toolUse", timestamp: Date.parse("2026-07-13T10:02:02.000Z") }
	},
	{
		id: "undated-message",
		intent: "Preserve the observed role while leaving a missing event timestamp unavailable.",
		sessionId: "44444444-4444-4444-8444-444444444444",
		lines: [
			{ type: "session", timestamp: "2026-07-13T10:03:00.000Z", cwd: "/workspace/private-project" },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "Private undated task" }] } }
		],
		expected: { role: "user", stopReason: null, timestamp: null }
	}
];

try {
	for (const definition of definitions) {
		const file = join(root, `2026-07-13T10-00-00-000Z_${definition.sessionId}.jsonl`);
		const serialized = definition.lines.map((line) => JSON.stringify(line)).join("\n");
		await writeFile(file, `${serialized}\n${definition.trailingRaw || ""}${definition.trailingRaw ? "\n" : ""}`, "utf8");
	}

	const sessions = await readPiHistory(root, "2026-07-13", "2026-07-13", resolvePrivacyConfig("strict"));
	const results = definitions.map((definition) => {
		const session = sessions.find((item) => item.sessionId === definition.sessionId);
		const actual = {
			role: session?.lastMessageRole ?? null,
			stopReason: session?.lastMessageStopReason ?? null,
			timestamp: session?.lastMessageTimestamp ?? null
		};
		const strictSerialized = JSON.stringify(session);
		const assertions = [
			{ name: "lifecycle tuple", pass: isDeepStrictEqual(actual, definition.expected), expected: definition.expected, actual },
			{ name: "lifecycle capability declared", pass: session?.sourceCapabilities?.includes("lifecycle-event") === true, expected: true, actual: session?.sourceCapabilities?.includes("lifecycle-event") === true },
			{ name: "private transcript content absent", pass: !/Private (?:completed answer|tool payload|current task|undated task)/.test(strictSerialized), expected: true, actual: !/Private (?:completed answer|tool payload|current task|undated task)/.test(strictSerialized) }
		];
		return { id: definition.id, intent: definition.intent, pass: assertions.every((item) => item.pass), assertions };
	});

	const comparisons = definitions.map((definition) => {
		const result = results.find((item) => item.id === definition.id)!;
		return {
			caseId: definition.id,
			baseline: { role: null, stopReason: null, timestamp: null },
			candidate: result.assertions[0].actual,
			expected: definition.expected,
			baselinePass: isDeepStrictEqual({ role: null, stopReason: null, timestamp: null }, definition.expected),
			candidatePass: result.assertions[0].pass
		};
	});
	const assertions = results.flatMap((result) => result.assertions);
	const status = assertions.every((item) => item.pass) ? "pass" : "fail";
	const receipt = {
		schemaVersion: "agent-optic-pi-lifecycle-eval-receipt/v1",
		status,
		eval: "pi-lifecycle-extraction",
		mode: "deterministic-comparative-jsonl-replay",
		startedAt: startedAt.toISOString(),
		completedAt: new Date().toISOString(),
		model: null,
		usage: null,
		comparison: {
			baseline: { contract: "Pi SessionInfo before lifecycle-event fields", passed: comparisons.filter((item) => item.baselinePass).length, total: comparisons.length },
			candidate: { contract: "Pi SessionInfo lifecycle-event fields", passed: comparisons.filter((item) => item.candidatePass).length, total: comparisons.length },
			observations: comparisons
		},
		summary: {
			cases: results.length,
			passedCases: results.filter((result) => result.pass).length,
			assertions: assertions.length,
			passedAssertions: assertions.filter((item) => item.pass).length
		},
		killCriterion: "Do not expose Pi lifecycle evidence if the latest valid role/stop/timestamp tuple is wrong, lifecycle capability is missing, or private transcript content leaks into strict SessionInfo output.",
		results,
		artifacts: { receipt: receiptPath },
		entrypoint: "bun run eval:pi-lifecycle"
	};
	await mkdir(outDir, { recursive: true });
	await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
	console.log(`${status.toUpperCase()} ${receipt.summary.passedCases}/${receipt.summary.cases} cases; candidate ${receipt.comparison.candidate.passed}/${comparisons.length}, baseline ${receipt.comparison.baseline.passed}/${comparisons.length}`);
	console.log(`receipt: ${receiptPath}`);
	process.exitCode = status === "pass" ? 0 : 1;
} finally {
	await rm(root, { recursive: true, force: true });
}
