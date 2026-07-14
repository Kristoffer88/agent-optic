import { describe, expect, test } from "bun:test";
import { collectSessionObservation } from "../src/collectors/session-observation.js";
import type { Provider } from "../src/types/provider.js";
import type { SessionMeta } from "../src/types/session.js";

const collectForTest = collectSessionObservation as unknown as (
	options: Parameters<typeof collectSessionObservation>[0],
	dependencies: Record<string, unknown>,
) => ReturnType<typeof collectSessionObservation>;

function session(sessionId: string, end: number, prompts: string[]): SessionMeta {
	return {
		sessionId,
		project: `/Users/example/projects/${sessionId}`,
		projectName: sessionId,
		prompts,
		promptTimestamps: prompts.map((_, index) => end - prompts.length + index),
		timeRange: { start: end - 100, end },
		userPromptCount: prompts.length,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
		messageCount: prompts.length,
	};
}

describe("collectSessionObservation", () => {
	test("collects providers once, bounds prompts, and orders sessions deterministically", async () => {
		const rows: Partial<Record<Provider, SessionMeta[]>> = {
			pi: [session("pi-old", 100, ["one", "two", "three"]), session("pi-new", 300, ["a very long prompt"])],
			codex: [session("codex", 200, ["codex prompt"])],
		};
		(rows.pi?.[1] as SessionMeta & { futurePrivateField: string }).futurePrivateField = "must-not-escape-v1";
		(rows.pi?.[1].timeRange as { start: number; end: number; futureNestedField: string }).futureNestedField = "nested-must-not-escape-v1";
		rows.pi![1].sourceCapabilities = ["prompt", "future-capability"] as unknown as SessionMeta["sourceCapabilities"];
		const observation = await collectForTest({
			providers: ["pi", "codex", "claude", "pi"],
			maxSessions: 2,
			maxPrompts: 2,
			maxPromptChars: 8,
		}, {
			existsSync: (providerDir) => !String(providerDir).endsWith("/.claude"),
			createHistory: ((config: { provider: Provider }) => ({
				sessions: { listWithMeta: async () => rows[config.provider] ?? [] },
			})) as any,
			now: () => 1_000,
		});

		expect(observation.schemaVersion).toBe("agent-optic.observation/v1");
		expect(observation.availability).toBe("partial");
		expect(observation.query.providers).toEqual(["pi", "codex", "claude"]);
		expect(observation.sessions.map((item) => item.sessionId)).toEqual(["pi-new", "codex"]);
		expect(observation.sessions[0].prompts).toEqual(["a very…"]);
		expect(observation.completeness).toEqual({ observedSessions: 3, returnedSessions: 2, truncated: true });
		expect(observation.capabilities).toContain("provider-health");
		expect(JSON.stringify(observation)).not.toContain("must-not-escape-v1");
		expect(JSON.stringify(observation)).not.toContain("nested-must-not-escape-v1");
		expect(JSON.stringify(observation)).not.toContain("future-capability");
		expect(observation.sessions[0].sourceCapabilities).toEqual(["prompt"]);
		expect(observation.providers.find((item) => item.provider === "claude")?.status).toBe("absent");
	});

	test("keeps partial evidence and returns a sanitized provider error", async () => {
		const observation = await collectForTest({
			providers: ["pi", "codex"],
			privacy: "shareable",
		}, {
			existsSync: () => true,
			createHistory: ((config: { provider: Provider }) => ({
				sessions: {
					listWithMeta: async () => {
						if (config.provider === "codex") throw new Error("bad file /Users/example/private/token.json");
						return [session("pi", 300, ["safe"] )];
					},
				},
			})) as any,
			now: () => 1_000,
		});

		expect(observation.availability).toBe("partial");
		const error = observation.providers.find((item) => item.provider === "codex")?.error;
		expect(error?.code).toBe("PROVIDER_READ_FAILED");
		expect(error?.message).not.toContain("/Users/example");
		expect(error?.message).toContain("private/token.json");
	});

	test("records and forwards the effective default date", async () => {
		const filters: unknown[] = [];
		const now = new Date(2026, 0, 2, 12).getTime();
		const observation = await collectForTest({
			providers: ["pi"],
		}, {
			existsSync: () => true,
			createHistory: (() => ({
				sessions: {
					listWithMeta: async (filter: unknown) => {
						filters.push(filter);
						return [];
					},
				},
			})) as any,
			now: () => now,
		});

		expect(observation.query.date).toBe("2026-01-02");
		expect(filters).toEqual([{ date: "2026-01-02", from: undefined, to: undefined, project: undefined }]);
	});

	test("forwards an exact date and canonicalizes the OpenAI alias once", async () => {
		const filters: unknown[] = [];
		const observation = await collectForTest({
			providers: ["openai", "codex"],
			date: "2026-01-02",
		}, {
			existsSync: () => true,
			createHistory: (() => ({
				sessions: {
					listWithMeta: async (filter: unknown) => {
						filters.push(filter);
						return [session("codex", 300, ["safe"])];
					},
				},
			})) as any,
			now: () => 1_000,
		});

		expect(observation.query.providers).toEqual(["codex"]);
		expect(observation.providers.map((item) => item.provider)).toEqual(["codex"]);
		expect(observation.sessions.map((item) => item.provider)).toEqual(["codex"]);
		expect(observation.query.date).toBe("2026-01-02");
		expect(filters).toEqual([{ date: "2026-01-02", from: undefined, to: undefined, project: undefined }]);
	});
});
