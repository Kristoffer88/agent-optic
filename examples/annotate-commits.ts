#!/usr/bin/env bun
/**
 * annotate-commits.ts — Write AI cost data as git notes on each commit in .ai-usage.jsonl
 *
 * Usage:
 *   bun examples/annotate-commits.ts [path-to-repo]   # default: cwd
 *   bun examples/annotate-commits.ts --push           # also push notes to origin
 *
 * After running, git log --show-notes displays AI cost inline:
 *
 *   commit ad7ac31...
 *       Fix messageCount: also exclude toolUseResult carriers
 *
 *   Notes:
 *       AI: $2.71 | out: 21K | cache: 5.8M | sessions: 9 | claude-sonnet-4-6
 */

import { join } from "node:path";
import { existsSync } from "node:fs";

interface UsageRecord {
	commit: string;
	tokens: { input: number; output: number; cache_read: number; cache_write: number };
	cost_usd: number;
	models: string[];
	session_ids: string[];
}

function fmt(n: number): string {
	if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
	if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
	return String(n);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const text = await new Response(proc.stdout).text();
	await proc.exited;
	return text.trim();
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
	const totalTokens = r.tokens.input + r.tokens.output + r.tokens.cache_read + r.tokens.cache_write;
	const model = r.models[0] ?? "unknown";

	const note = [
		`AI: $${r.cost_usd.toFixed(2)}`,
		`out: ${fmt(r.tokens.output)}`,
		`cache: ${fmt(r.tokens.cache_read)}`,
		`sessions: ${r.session_ids.length}`,
		model,
	].join(" | ");

	// -f overwrites any existing note for this commit
	const proc = Bun.spawn(["git", "notes", "add", "-f", "-m", note, r.commit], {
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
console.log(`\nView with: git log --show-notes`);

// ── Push notes ────────────────────────────────────────────────────────

if (push) {
	console.log("\nPushing notes to origin...");
	const proc = Bun.spawn(["git", "push", "origin", "refs/notes/commits"], {
		cwd: repoPath,
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	if (exitCode === 0) {
		console.log("Notes pushed. Others can fetch with:");
		console.log("  git fetch origin refs/notes/commits:refs/notes/commits");
	} else {
		console.error("Push failed:", err.trim() || out.trim());
	}
}
