#!/usr/bin/env bun
/**
 * commit-tracker.ts — Post-commit hook that tracks AI usage per commit.
 *
 * Usage:
 *   bun examples/commit-tracker.ts install    — Install post-commit git hook
 *   bun examples/commit-tracker.ts uninstall  — Remove the hook
 *   bun examples/commit-tracker.ts run        — Called by hook after each commit
 *
 * Appends a JSONL record to .ai-usage.jsonl for each commit that matches
 * a Claude session (within a configurable time window).
 */

import { createClaudeHistory, estimateCost, projectName, type SessionMeta } from "../src/index.js";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";

const MARKER_START = "# claude-optic: ai-usage-tracker";
const MARKER_END = "# end claude-optic";
const TRACKING_FILE = ".ai-usage.jsonl";
const WINDOW_MINUTES = 30;

// ── Git helpers ──────────────────────────────────────────────────────

async function git(...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
	const text = await new Response(proc.stdout).text();
	await proc.exited;
	return text.trim();
}

async function getRepoRoot(): Promise<string> {
	return git("rev-parse", "--show-toplevel");
}

// ── Install / Uninstall ──────────────────────────────────────────────

async function install() {
	const repoRoot = await getRepoRoot();
	const hooksDir = join(repoRoot, ".git", "hooks");
	const hookPath = join(hooksDir, "post-commit");
	const scriptPath = resolve(import.meta.dir, "commit-tracker.ts");

	const hookBlock = [
		MARKER_START,
		`bun ${scriptPath} run 2>/dev/null || true`,
		MARKER_END,
	].join("\n");

	if (existsSync(hookPath)) {
		const existing = await Bun.file(hookPath).text();

		if (existing.includes(MARKER_START)) {
			console.log("Hook already installed.");
			return;
		}

		// Append to existing hook
		await Bun.write(hookPath, existing.trimEnd() + "\n\n" + hookBlock + "\n");
	} else {
		await Bun.write(hookPath, "#!/bin/sh\n\n" + hookBlock + "\n");
	}

	// Ensure executable
	await Bun.spawn(["chmod", "+x", hookPath]).exited;

	console.log(`Installed post-commit hook → ${hookPath}`);
	console.log(`Tracking file: ${join(repoRoot, TRACKING_FILE)}`);
}

async function uninstall() {
	const repoRoot = await getRepoRoot();
	const hookPath = join(repoRoot, ".git", "hooks", "post-commit");

	if (!existsSync(hookPath)) {
		console.log("No post-commit hook found.");
		return;
	}

	const existing = await Bun.file(hookPath).text();
	if (!existing.includes(MARKER_START)) {
		console.log("Hook not installed by commit-tracker.");
		return;
	}

	// Remove lines between markers (inclusive)
	const lines = existing.split("\n");
	const filtered: string[] = [];
	let inside = false;
	for (const line of lines) {
		if (line.trim() === MARKER_START) { inside = true; continue; }
		if (line.trim() === MARKER_END) { inside = false; continue; }
		if (!inside) filtered.push(line);
	}

	const remaining = filtered.join("\n").trim();
	if (remaining === "#!/bin/sh" || remaining === "") {
		// Nothing left — remove the file
		await Bun.spawn(["rm", hookPath]).exited;
		console.log("Removed post-commit hook (no other hooks remained).");
	} else {
		await Bun.write(hookPath, remaining + "\n");
		console.log("Removed commit-tracker from post-commit hook.");
	}
}

// ── Run (called by hook) ─────────────────────────────────────────────

interface CommitInfo {
	hash: string;
	timestamp: number;
	branch: string;
	author: string;
	filesChanged: number;
}

async function getCommitInfo(): Promise<CommitInfo> {
	const [hash, timestampStr, branch, author, statText] = await Promise.all([
		git("rev-parse", "HEAD"),
		git("log", "-1", "--format=%at"),
		git("rev-parse", "--abbrev-ref", "HEAD"),
		git("log", "-1", "--format=%an"),
		git("diff", "--stat", "HEAD~1..HEAD"),
	]);

	const filesMatch = statText.match(/(\d+) files? changed/);
	const filesChanged = filesMatch ? parseInt(filesMatch[1]) : 0;

	return {
		hash: hash.slice(0, 7),
		timestamp: parseInt(timestampStr) * 1000,
		branch,
		author,
		filesChanged,
	};
}

function findMatchingSessions(commitTimestamp: number, sessions: SessionMeta[]): SessionMeta[] {
	const windowMs = WINDOW_MINUTES * 60 * 1000;
	return sessions.filter((s) => {
		return s.timeRange.start <= commitTimestamp + windowMs && s.timeRange.end >= commitTimestamp - windowMs;
	});
}

async function run() {
	const repoRoot = await getRepoRoot();
	const repoName = projectName(repoRoot);
	const commit = await getCommitInfo();

	// Get today's sessions for this project
	const today = new Date().toISOString().slice(0, 10);
	const ch = createClaudeHistory();
	const allSessions = await ch.sessions.listWithMeta({ from: today });

	// Filter to matching project
	const projectSessions = allSessions.filter((s) => {
		return s.project === repoRoot || repoRoot.startsWith(s.project + "/") || s.project.startsWith(repoRoot + "/") || s.projectName === repoName;
	});

	// Find sessions active around commit time
	const matched = findMatchingSessions(commit.timestamp, projectSessions);
	if (matched.length === 0) return; // No AI involvement — skip silently

	// Aggregate tokens and cost
	const tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
	let messages = 0;
	const models = new Set<string>();

	for (const s of matched) {
		tokens.input += s.totalInputTokens;
		tokens.output += s.totalOutputTokens;
		tokens.cache_read += s.cacheReadInputTokens;
		tokens.cache_write += s.cacheCreationInputTokens;
		messages += s.messageCount;
		if (s.model) models.add(s.model);
	}

	const costUsd = matched.reduce((sum, s) => sum + estimateCost(s), 0);

	const record = {
		commit: commit.hash,
		timestamp: new Date(commit.timestamp).toISOString(),
		branch: commit.branch,
		author: commit.author,
		sessions: matched.length,
		tokens,
		cost_usd: Math.round(costUsd * 100) / 100,
		models: [...models],
		messages,
		files_changed: commit.filesChanged,
	};

	// Append to tracking file
	const trackingPath = join(repoRoot, TRACKING_FILE);
	await Bun.write(trackingPath, (existsSync(trackingPath) ? await Bun.file(trackingPath).text() : "") + JSON.stringify(record) + "\n");
}

// ── CLI ──────────────────────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
	case "install":
		await install();
		break;
	case "uninstall":
		await uninstall();
		break;
	case "run":
		await run();
		break;
	default:
		console.log(`Usage: bun examples/commit-tracker.ts <install|uninstall|run>

  install    Install post-commit git hook in current repo
  uninstall  Remove the hook
  run        Record AI usage for the latest commit (called by hook)`);
}
