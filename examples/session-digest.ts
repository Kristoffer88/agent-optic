#!/usr/bin/env bun
/**
 * session-digest.ts — Export compact session summaries as JSON.
 *
 * Usage:
 *   bun examples/session-digest.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--days 7] [--top N]
 *
 * Uses listWithMeta() only (no detail() calls) for speed.
 * Filters out zero-prompt sessions, sorts by most recent first.
 */

import { createClaudeHistory, estimateCost, toLocalDate } from "../src/index.js";

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
	const idx = args.indexOf(name);
	return idx !== -1 ? (args[idx + 1] ?? fallback) : fallback;
}

const MAX_PROMPT_LENGTH = 150;
const DEFAULT_TOP = 35;

const days = parseInt(getArg("--days", "7"));
const from = getArg("--from", toLocalDate(Date.now() - days * 86400000));
const to = getArg("--to", toLocalDate(Date.now()));
const topN = parseInt(getArg("--top", String(DEFAULT_TOP)));

function clean(text: string): string {
	return text
		.replace(/\[Pasted text[^\]]*\]/g, "[paste]")
		.replace(/\s+/g, " ")
		.trim();
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, max) + "...";
}

function firstPrompt(prompts: string[]): string | null {
	for (const p of prompts) {
		const cleaned = clean(p);
		if (cleaned.length > 0) return truncate(cleaned, MAX_PROMPT_LENGTH);
	}
	return null;
}

async function main() {
	const ch = createClaudeHistory();
	const sessions = await ch.sessions.listWithMeta({ from, to });

	const filtered = sessions
		.filter((s) => s.prompts.length > 0)
		.sort((a, b) => b.timeRange.start - a.timeRange.start)
		.slice(0, topN);

	const digests = filtered.map((s) => ({
		sessionId: s.sessionId,
		project: s.projectName,
		date: toLocalDate(s.timeRange.start),
		branch: s.gitBranch ?? null,
		model: s.model ?? null,
		promptCount: s.prompts.length,
		firstPrompt: firstPrompt(s.prompts),
		messageCount: s.messageCount,
		durationMinutes: Math.round((s.timeRange.end - s.timeRange.start) / 60000),
		estimatedCostUsd: +estimateCost(s).toFixed(4),
		tokens: {
			input: s.totalInputTokens,
			output: s.totalOutputTokens,
			cacheWrite: s.cacheCreationInputTokens,
			cacheRead: s.cacheReadInputTokens,
		},
	}));

	console.log(
		JSON.stringify(
			{
				period: { from, to },
				totalSessions: sessions.length,
				sessions: digests,
			},
			null,
			2,
		),
	);
}

main().catch(console.error);
