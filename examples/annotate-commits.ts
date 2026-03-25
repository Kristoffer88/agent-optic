#!/usr/bin/env bun
/**
 * annotate-commits.ts — Write AI cost data as git notes on each commit in .ai-usage.jsonl
 *
 * Uses the refs/notes/ai namespace (compatible with git-ai tooling).
 * Each note has a human-readable summary line followed by a machine-readable JSON section.
 *
 * Usage:
 *   bun examples/annotate-commits.ts [path-to-repo]   # default: cwd
 *   bun examples/annotate-commits.ts --push           # also push notes to origin
 *
 * After running, git log --show-notes=ai displays AI cost inline:
 *
 *   commit ad7ac31...
 *       Fix messageCount: also exclude toolUseResult carriers
 *
 *   Notes (ai):
 *       AI: $2.71 | out: 21K | cache: 5.8M | sessions: 9 | claude-sonnet-4-6
 *       ---
 *       {"schema":"agent-optic/1.0","cost_usd":2.71,...}
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { fmtTokens } from "./git-helpers.js";

const NOTES_REF = "refs/notes/ai";

interface UsageRecord {
	commit: string;
	branch?: string;
	tokens: { input: number; output: number; cache_read: number; cache_write: number };
	cost_usd: number;
	models: string[];
	session_ids: string[];
	messages?: number;
	files_changed?: number;
	ai_tool?: string;
}

// ── CLI args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const push = args.includes("--push");
const repoArg = args.find((a) => !a.startsWith("--"));
const repoPath = repoArg ? repoArg : process.cwd();
const trackingPath = join(repoPath, ".ai-usage.jsonl");

if (!existsSync(trackingPath)) {
	console.error(`No .ai-usage.jsonl found in ${repoPath}`);
	console.error("Run: bun examples/commit-tracker.ts init");
	process.exit(1);
}

// ── Load records ──────────────────────────────────────────────────────

const records: UsageRecord[] = [];
for (const line of (await Bun.file(trackingPath).text()).trim().split("\n")) {
	if (!line.trim()) continue;
	try { records.push(JSON.parse(line) as UsageRecord); } catch {}
}

if (records.length === 0) {
	console.log("No records found.");
	process.exit(0);
}

// ── Annotate ──────────────────────────────────────────────────────────

let annotated = 0;
let skipped = 0;

for (const r of records) {
	const model = r.models[0] ?? "unknown";

	const summary = [
		`AI: $${r.cost_usd.toFixed(2)}`,
		`out: ${fmtTokens(r.tokens.output)}`,
		`cache: ${fmtTokens(r.tokens.cache_read)}`,
		`sessions: ${r.session_ids.length}`,
		model,
	].join(" | ");

	const meta = JSON.stringify({
		schema: "agent-optic/1.0",
		sessions: r.session_ids,
		tokens: r.tokens,
		cost_usd: r.cost_usd,
		models: r.models,
		...(r.branch ? { branch: r.branch } : {}),
		...(r.messages !== undefined ? { messages: r.messages } : {}),
		...(r.files_changed !== undefined ? { files_changed: r.files_changed } : {}),
		...(r.ai_tool ? { ai_tool: r.ai_tool } : {}),
	});

	const note = `${summary}\n---\n${meta}`;

	const proc = Bun.spawn(["git", "notes", "--ref", NOTES_REF, "add", "-f", "-m", note, r.commit], {
		cwd: repoPath,
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;

	if (exitCode === 0) {
		annotated++;
	} else {
		const err = await new Response(proc.stderr).text();
		// "bad object" means the commit hash doesn't exist in this repo — skip silently
		if (!err.includes("bad object") && !err.includes("not a valid")) {
			console.warn(`  skipped ${r.commit}: ${err.trim()}`);
		}
		skipped++;
	}
}

console.log(`${annotated} commits annotated, ${skipped} skipped (not in this repo)`);
console.log(`\nView with: git log --show-notes=ai`);

// ── Push notes ────────────────────────────────────────────────────────

if (push) {
	console.log("\nPushing notes to origin...");
	const proc = Bun.spawn(["git", "push", "origin", `${NOTES_REF}:${NOTES_REF}`], {
		cwd: repoPath,
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	if (exitCode === 0) {
		console.log("Notes pushed. Others can fetch with:");
		console.log(`  git fetch origin ${NOTES_REF}:${NOTES_REF}`);
	} else {
		console.error("Push failed:", err.trim() || out.trim());
	}
}
