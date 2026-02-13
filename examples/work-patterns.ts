#!/usr/bin/env bun
/**
 * work-patterns.ts — Export aggregated work pattern metrics as JSON.
 *
 * Usage:
 *   bun examples/work-patterns.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *
 * Outputs hour distribution, late-night/weekend counts, longest and most
 * expensive sessions — all as JSON for an LLM to interpret.
 */

import { createClaudeHistory, estimateCost, toLocalDate, type SessionMeta } from "../src/index.js";

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
	const idx = args.indexOf(name);
	return idx !== -1 ? (args[idx + 1] ?? fallback) : fallback;
}

const from = getArg("--from", toLocalDate(new Date(Date.now() - 30 * 86400000)));
const to = getArg("--to", toLocalDate(new Date()));

function durationMinutes(s: SessionMeta): number {
	return (s.timeRange.end - s.timeRange.start) / 60000;
}

async function main() {
	const ch = createClaudeHistory();
	const sessions = await ch.sessions.listWithMeta({ from, to });

	if (sessions.length === 0) {
		console.log(JSON.stringify({ period: { from, to }, totalSessions: 0 }, null, 2));
		return;
	}

	const totalCost = sessions.reduce((s, x) => s + estimateCost(x), 0);
	const totalHours = ch.aggregate.estimateHours(sessions);
	const totalTokens = sessions.reduce(
		(s, x) => s + x.totalInputTokens + x.totalOutputTokens + x.cacheCreationInputTokens + x.cacheReadInputTokens,
		0,
	);

	const hourBuckets = new Array(24).fill(0);
	for (const s of sessions) {
		hourBuckets[new Date(s.timeRange.start).getHours()]++;
	}

	const lateNightCount = sessions.filter((s) => {
		const h = new Date(s.timeRange.start).getHours();
		return h >= 22 || h < 5;
	}).length;

	const weekendCount = sessions.filter((s) => {
		const day = new Date(s.timeRange.start).getDay();
		return day === 0 || day === 6;
	}).length;

	const byDate = new Map<string, number>();
	for (const s of sessions) {
		const date = toLocalDate(new Date(s.timeRange.start));
		byDate.set(date, (byDate.get(date) ?? 0) + 1);
	}
	const busiestDay = [...byDate.entries()].sort((a, b) => b[1] - a[1])[0];

	const peakHour = hourBuckets.indexOf(Math.max(...hourBuckets));

	const byDuration = [...sessions].sort((a, b) => durationMinutes(b) - durationMinutes(a));
	const byCost = [...sessions].sort((a, b) => estimateCost(b) - estimateCost(a));

	const longestSessions = byDuration.slice(0, 5).map((s) => ({
		date: toLocalDate(new Date(s.timeRange.start)),
		project: s.projectName,
		durationMinutes: Math.round(durationMinutes(s)),
		prompts: s.prompts.length,
	}));

	const mostExpensiveSessions = byCost.slice(0, 5).map((s) => ({
		date: toLocalDate(new Date(s.timeRange.start)),
		project: s.projectName,
		model: s.model ?? null,
		estimatedCostUsd: +estimateCost(s).toFixed(4),
	}));

	// Per-project breakdown (top 10)
	const projectMap = new Map<string, SessionMeta[]>();
	for (const s of sessions) {
		let arr = projectMap.get(s.projectName);
		if (!arr) {
			arr = [];
			projectMap.set(s.projectName, arr);
		}
		arr.push(s);
	}
	const byProject = [...projectMap.entries()]
		.sort((a, b) => b[1].length - a[1].length)
		.slice(0, 10)
		.map(([project, projectSessions]) => ({
			project,
			sessions: projectSessions.length,
			estimatedHours: +ch.aggregate.estimateHours(projectSessions).toFixed(1),
			estimatedCostUsd: +projectSessions.reduce((s, x) => s + estimateCost(x), 0).toFixed(2),
		}));

	console.log(
		JSON.stringify(
			{
				period: { from, to },
				totalSessions: sessions.length,
				totalEstimatedHours: +totalHours.toFixed(1),
				totalTokens,
				totalEstimatedCostUsd: +totalCost.toFixed(2),
				peakHour,
				hourDistribution: Object.fromEntries(hourBuckets.map((count, hour) => [hour, count]).filter(([, c]) => c > 0)),
				lateNightSessions: lateNightCount,
				weekendSessions: weekendCount,
				busiestDay: busiestDay ? { date: busiestDay[0], sessions: busiestDay[1] } : null,
				byProject,
				longestSessions,
				mostExpensiveSessions,
			},
			null,
			2,
		),
	);
}

main().catch(console.error);
