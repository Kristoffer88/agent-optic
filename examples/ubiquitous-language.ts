#!/usr/bin/env bun
/**
 * ubiquitous-language.ts — Extract domain signals from AI conversations + repo
 * structure for a project, output XML that Claude Code can consume to generate
 * a UBIQUITOUS_LANGUAGE.md file.
 *
 * Usage:
 *   bun examples/ubiquitous-language.ts --project <name> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--days 90]
 *
 * Outputs XML with an appended generation prompt — pipe directly to an LLM:
 *   bun examples/ubiquitous-language.ts --project PowerGantt | claude --print
 */

import { createHistory, toLocalDate } from "../src/index.js";

const args = process.argv.slice(2);
function getArg(name: string, fallback?: string): string | undefined {
	const idx = args.indexOf(name);
	return idx !== -1 ? (args[idx + 1] ?? fallback) : fallback;
}

const project = getArg("--project");
if (!project) {
	console.error("Usage: bun examples/ubiquitous-language.ts --project <name> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--days 90]");
	process.exit(1);
}

const days = parseInt(getArg("--days", "90")!, 10);
const from = getArg("--from", toLocalDate(Date.now() - days * 86400000))!;
const to = getArg("--to", toLocalDate(Date.now()))!;

const MAX_SESSIONS = 30;
const MAX_PROMPTS_PER_SESSION = 6;
const MAX_FILES = 80;
const MAX_BRANCHES = 30;
const MAX_TEXT_LEN = 200;
const MAX_CONTEXT_LEN = 2000;
const SIZE_BUDGET = 10_000;

function escAttr(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escContent(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s: string, max: number): string {
	const clean = s.replace(/\s+/g, " ").trim();
	return clean.length <= max ? clean : clean.slice(0, max) + "...";
}

async function main() {
	const ch = createHistory({ provider: "claude" });
	const sessions = await ch.sessions.list({ from, to, project });

	if (sessions.length === 0) {
		console.error(`No sessions found for project matching "${project}" between ${from} and ${to}`);
		process.exit(1);
	}

	// Pick sessions with 3+ prompts, cap at MAX_SESSIONS
	const rich = sessions
		.filter((s) => s.prompts.length >= 3)
		.slice(0, MAX_SESSIONS);

	// Load details in parallel, keep original SessionInfo for fallback dates/prompts
	const detailPairs = await Promise.all(
		rich.map(async (s) => ({ info: s, detail: await ch.sessions.detail(s.sessionId, s.project) })),
	);
	const details = detailPairs.map(({ info, detail }) => ({
		...detail,
		// detail may have empty prompts/timeRange when parsed from JSONL; fall back to history.jsonl data
		prompts: detail.prompts.length > 0 ? detail.prompts : info.prompts,
		timeRange: detail.timeRange.start > 0 ? detail.timeRange : info.timeRange,
	}));

	// Try to load project memory from the first session's project path
	const projectPath = sessions[0].project;
	const memory = await ch.projects.memory(projectPath);

	// Collect files by frequency
	const fileFreq = new Map<string, number>();
	for (const d of details) {
		for (const f of d.filesReferenced) {
			fileFreq.set(f, (fileFreq.get(f) || 0) + 1);
		}
	}
	const topFiles = [...fileFreq.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, MAX_FILES)
		.map(([f]) => f);

	// Collect branches
	const branchSet = new Set<string>();
	for (const d of details) {
		if (d.gitBranch) branchSet.add(d.gitBranch);
	}
	const branches = [...branchSet].slice(0, MAX_BRANCHES);

	// Trim sessions until output fits budget
	let sessionSlice = details;
	const projectName = sessions[0].projectName;
	let xml = renderXml(sessionSlice, topFiles, branches, memory, projectName);
	while (xml.length > SIZE_BUDGET && sessionSlice.length > 3) {
		const ratio = SIZE_BUDGET / xml.length;
		const reduced = Math.max(3, Math.floor(sessionSlice.length * ratio * 0.85));
		sessionSlice = sessionSlice.slice(0, reduced);
		xml = renderXml(sessionSlice, topFiles, branches, memory, projectName);
	}

	console.log(xml);
}

type DetailLike = { sessionId: string; prompts: string[]; timeRange: { start: number; end: number }; gitBranch?: string; assistantSummaries: string[] };

function renderXml(
	details: DetailLike[],
	files: string[],
	branches: string[],
	memory: { content: string } | null,
	projectName: string,
): string {
	const lines: string[] = [];

	lines.push(`<ubiquitous-language project="${escAttr(projectName)}" period="${escAttr(from)} to ${escAttr(to)}">`);

	if (memory?.content) {
		lines.push(`  <project-context>`);
		lines.push(`    ${escContent(truncate(memory.content, MAX_CONTEXT_LEN))}`);
		lines.push(`  </project-context>`);
	}

	lines.push(`  <conversations count="${details.length}">`);
	for (const d of details) {
		const date = toLocalDate(d.timeRange.start);
		const branch = d.gitBranch ? ` branch="${escAttr(d.gitBranch)}"` : "";
		lines.push(`    <session id="${escAttr(d.sessionId)}" date="${escAttr(date)}"${branch} prompts="${d.prompts.length}">`);
		for (const p of sampleArray(d.prompts, MAX_PROMPTS_PER_SESSION)) {
			lines.push(`      <prompt>${escContent(truncate(p, MAX_TEXT_LEN))}</prompt>`);
		}
		for (const s of d.assistantSummaries.slice(0, 3)) {
			lines.push(`      <summary>${escContent(truncate(s, MAX_TEXT_LEN))}</summary>`);
		}
		lines.push(`    </session>`);
	}
	lines.push(`  </conversations>`);

	lines.push(`  <files count="${files.length}">`);
	for (const f of files) {
		lines.push(`    <file>${escContent(f)}</file>`);
	}
	lines.push(`  </files>`);

	if (branches.length > 0) {
		lines.push(`  <branches>`);
		for (const b of branches) {
			lines.push(`    <branch>${escContent(b)}</branch>`);
		}
		lines.push(`  </branches>`);
	}

	lines.push(`</ubiquitous-language>`);
	lines.push("");
	lines.push(`Generate a UBIQUITOUS_LANGUAGE.md for the "${projectName}" project based on the XML above.`);
	lines.push(`The XML was extracted from AI coding sessions — focus entirely on ${projectName}'s domain, not the tool that extracted it.`);
	lines.push(`Infer the project's domain-specific terms, concepts, patterns, and conventions from the conversations, file names, branch names, and project context.`);
	lines.push(`Output only the markdown file content. Sections: Core Concepts, Domain Terms, Patterns, Conventions. Be concise.`);

	return lines.join("\n");
}

/** Evenly sample up to `max` items from an array. */
function sampleArray<T>(arr: T[], max: number): T[] {
	if (arr.length <= max) return arr;
	const step = arr.length / max;
	const result: T[] = [];
	for (let i = 0; i < max; i++) {
		result.push(arr[Math.floor(i * step)]);
	}
	return result;
}

main().catch(console.error);
