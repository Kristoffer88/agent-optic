#!/usr/bin/env bun
/**
 * prompt-history.ts — Export sampled prompts grouped by project as JSON.
 *
 * Usage:
 *   bun examples/prompt-history.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *
 * Groups by project, deduplicates, samples proportionally, and truncates
 * so the output stays <10KB — small enough to pipe to `claude` or any LLM.
 */

import { createClaudeHistory, toLocalDate } from "../src/index.js";

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
	const idx = args.indexOf(name);
	return idx !== -1 ? (args[idx + 1] ?? fallback) : fallback;
}

const from = getArg("--from", toLocalDate(Date.now() - 30 * 86400000));
const to = getArg("--to", toLocalDate(Date.now()));

const MAX_PROJECTS = 15;
const MAX_TOTAL_SAMPLES = 80;
const MAX_PROMPT_LENGTH = 120;

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

function dedupeKey(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
}

async function main() {
	const ch = createClaudeHistory();
	const sessions = await ch.sessions.list({ from, to });

	// Group prompts by project
	const byProject = new Map<string, { sessionIds: Set<string>; prompts: string[] }>();
	let totalPrompts = 0;

	for (const s of sessions) {
		let entry = byProject.get(s.projectName);
		if (!entry) {
			entry = { sessionIds: new Set(), prompts: [] };
			byProject.set(s.projectName, entry);
		}
		entry.sessionIds.add(s.sessionId);
		for (const prompt of s.prompts) {
			const cleaned = clean(prompt);
			if (cleaned.length === 0) continue;
			entry.prompts.push(cleaned);
			totalPrompts++;
		}
	}

	// Deduplicate and sample per project (top N projects by prompt count)
	const topProjects = [...byProject.entries()]
		.sort((a, b) => b[1].prompts.length - a[1].prompts.length)
		.slice(0, MAX_PROJECTS);
	const numProjects = topProjects.length;
	const perProjectCap = Math.max(2, Math.floor(MAX_TOTAL_SAMPLES / (numProjects || 1)));

	const projectEntries = topProjects.map(([project, data]) => {
		// Deduplicate
		const seen = new Set<string>();
		const unique: string[] = [];
		for (const p of data.prompts) {
			const key = dedupeKey(p);
			if (!seen.has(key)) {
				seen.add(key);
				unique.push(p);
			}
		}

		// Sample evenly if over cap
		let sampled: string[];
		if (unique.length <= perProjectCap) {
			sampled = unique;
		} else {
			const step = unique.length / perProjectCap;
			sampled = [];
			for (let i = 0; i < perProjectCap; i++) {
				sampled.push(unique[Math.floor(i * step)]);
			}
		}

		return {
			project,
			sessionCount: data.sessionIds.size,
			promptCount: data.prompts.length,
			samples: sampled.map((p) => truncate(p, MAX_PROMPT_LENGTH)),
		};
	});

	console.log(
		JSON.stringify(
			{
				period: { from, to },
				totalSessions: sessions.length,
				totalPrompts,
				byProject: projectEntries,
			},
			null,
			2,
		),
	);
}

main().catch(console.error);
