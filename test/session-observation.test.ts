import { describe, expect, test } from "bun:test";
import { collectSessionObservation } from "../src/collectors/session-observation.js";
import type { Provider } from "../src/types/provider.js";
import type { SessionMeta } from "../src/types/session.js";

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
		const observation = await collectSessionObservation({
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
		expect(observation.providers.find((item) => item.provider === "claude")?.status).toBe("absent");
	});

	test("keeps partial evidence and returns a sanitized provider error", async () => {
		const observation = await collectSessionObservation({
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
});
