#!/usr/bin/env bun
/**
 * retrospective.ts — Dump the current session as JSON for retrospective analysis.
 *
 * Works with any provider that agent-optic has a reader for: claude, codex,
 * openai, pi, copilot, cursor, claude-desktop, opencode. Auto-detects the session id from CLAUDE_CODE_SESSION_ID
 * or CODEX_COMPANION_SESSION_ID; pass --session / --provider for other agents.
 *
 * Usage:
 *   bun examples/retrospective.ts                            # auto-detect
 *   bun examples/retrospective.ts --session <id>             # specific session id
 *   bun examples/retrospective.ts --provider copilot --session <id>
 *
 * The "Retrospective Knowledge Capture" pattern: after a session with an agent,
 * pipe this output back to the agent and ask what could have gone better. Store
 * the take-aways somewhere durable (e.g. `gh issue create -l agent-retrospective`)
 * so the team can review them on a cadence and turn them into changes to skills,
 * agent instructions (CLAUDE.md / AGENTS.md / .cursorrules / etc.), tests, dev
 * tooling, or the codebase itself.
 *
 * Flagging is individual and in-the-moment. Solving is a team activity. Decoupling
 * the two keeps capture friction low while giving fixes the discussion they deserve.
 */

import { createHistory, estimateCost, toLocalDate } from "../src/index.js";
import type { Provider } from "../src/index.js";

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
	const idx = args.indexOf(name);
	return idx !== -1 ? args[idx + 1] : undefined;
}

const provider = (getArg("--provider") ?? "claude") as Provider;
const sessionId =
	getArg("--session") ??
	process.env.CLAUDE_CODE_SESSION_ID ??
	process.env.CODEX_COMPANION_SESSION_ID;

if (!sessionId) {
	console.error(
		"error: no session id. Pass --session <id> or run inside a Claude Code / Codex session.",
	);
	process.exit(1);
}

async function main() {
	const ch = createHistory({ provider });
	const detail = await ch.sessions.detail(sessionId!);

	const toolByName: Record<string, number> = {};
	const toolByCategory: Record<string, number> = {};
	for (const call of detail.toolCalls) {
		toolByName[call.name] = (toolByName[call.name] ?? 0) + 1;
		toolByCategory[call.category] = (toolByCategory[call.category] ?? 0) + 1;
	}

	const output = {
		sessionId: detail.sessionId,
		project: detail.projectName,
		date: detail.timeRange.start ? toLocalDate(detail.timeRange.start) : null,
		branch: detail.gitBranch ?? null,
		model: detail.model ?? null,
		durationMinutes: detail.timeRange.end
			? Math.round((detail.timeRange.end - detail.timeRange.start) / 60000)
			: 0,
		messageCount: detail.messageCount,
		promptCount: detail.prompts.length,
		prompts: detail.prompts,
		assistantSummaries: detail.assistantSummaries,
		toolUsage: {
			total: detail.toolCalls.length,
			byCategory: toolByCategory,
			byName: toolByName,
		},
		filesReferenced: detail.filesReferenced,
		planReferenced: detail.planReferenced,
		thinkingBlockCount: detail.thinkingBlockCount,
		hasSidechains: detail.hasSidechains,
		tokens: {
			input: detail.totalInputTokens,
			output: detail.totalOutputTokens,
			cacheWrite: detail.cacheCreationInputTokens,
			cacheRead: detail.cacheReadInputTokens,
		},
		estimatedCostUsd: +estimateCost(detail).toFixed(4),
		retrospectivePrompts: [
			"Where did I have to redirect or correct you?",
			"What context were you missing that would have helped?",
			"Which tool calls were wasted, redundant, or in the wrong order?",
			"What should change in agent instructions (CLAUDE.md / AGENTS.md / .cursorrules / etc.), a skill, a test, or the codebase so the next session avoids these snags?",
		],
	};

	console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
