#!/usr/bin/env bun
/**
 * commit-tracker.ts — Post-commit hook that tracks AI usage per commit.
 *
 * Usage:
 *   bun examples/commit-tracker.ts install    — Install post-commit git hook
 *   bun examples/commit-tracker.ts uninstall  — Remove the hook
 *   bun examples/commit-tracker.ts run        — Called by hook after each commit
 *   bun examples/commit-tracker.ts init       — Backfill .ai-usage.jsonl for existing commits
 *
 * Appends a JSONL record to .ai-usage.jsonl for each commit that matches
 * a local assistant session (within a configurable time window).
 */

import { createHistory, estimateCost, projectName, type SessionMeta } from "../src/index.js";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const MARKER_START = "# agent-optic: ai-usage-tracker";
const MARKER_END = "# end agent-optic";
const LEGACY_MARKER_START = "# claude-optic: ai-usage-tracker";
const LEGACY_MARKER_END = "# end claude-optic";
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

		if (existing.includes(MARKER_START) || existing.includes(LEGACY_MARKER_START)) {
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
	if (!existing.includes(MARKER_START) && !existing.includes(LEGACY_MARKER_START)) {
		console.log("Hook not installed by commit-tracker.");
		return;
	}

	// Remove lines between markers (inclusive)
	const lines = existing.split("\n");
	const filtered: string[] = [];
	let inside = false;
	for (const line of lines) {
		if (line.trim() === MARKER_START || line.trim() === LEGACY_MARKER_START) { inside = true; continue; }
		if (line.trim() === MARKER_END || line.trim() === LEGACY_MARKER_END) { inside = false; continue; }
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
	message: string;
	filesChanged: number;
}

async function getCommitInfo(): Promise<CommitInfo> {
	const [hash, timestampStr, branch, author, message, statText] = await Promise.all([
		git("rev-parse", "HEAD"),
		git("log", "-1", "--format=%at"),
		git("rev-parse", "--abbrev-ref", "HEAD"),
		git("log", "-1", "--format=%an"),
		git("log", "-1", "--format=%s"),
		git("diff", "--stat", "HEAD~1..HEAD").catch(() => git("diff", "--stat", "--root", "HEAD")),
	]);

	const filesMatch = statText.match(/(\d+) files? changed/);
	const filesChanged = filesMatch ? parseInt(filesMatch[1]) : 0;

	return {
		hash: hash.slice(0, 7),
		timestamp: parseInt(timestampStr) * 1000,
		branch,
		author,
		message,
		filesChanged,
	};
}

function isProjectMatch(session: SessionMeta, repoRoot: string, repoName: string): boolean {
	const sp = session.project.toLowerCase();
	const rp = repoRoot.toLowerCase();
	return sp === rp || sp.startsWith(rp + "/") || session.projectName?.toLowerCase() === repoName.toLowerCase();
}

function findMatchingSessions(commitTimestamp: number, sessions: SessionMeta[]): SessionMeta[] {
	const windowMs = WINDOW_MINUTES * 60 * 1000;
	return sessions.filter((s) => {
		return s.timeRange.start <= commitTimestamp + windowMs && s.timeRange.end >= commitTimestamp - windowMs;
	});
}

/**
 * Resolve the exact Claude session active at commit time.
 *
 * Primary: scan ~/.claude/sessions/{pid}.json — live session files written by Claude Code
 * while a session is open. Each has { sessionId, cwd, startedAt }.
 * If exactly one matches the repo, that's the answer.
 *
 * Fallback: walk ~/.claude/history.jsonl backwards to find the most recent prompt
 * for this project at or before the commit timestamp.
 * If multiple live sessions exist, use history.jsonl as a tiebreaker.
 */
async function resolveSessionId(repoRoot: string, repoName: string, commitTs: number): Promise<string | undefined> {
	// --- Primary: live session files ---
	const sessionsDir = join(homedir(), ".claude", "sessions");
	const candidates: string[] = [];
	const glob = new Bun.Glob("*.json");
	try {
		for await (const f of glob.scan({ cwd: sessionsDir, onlyFiles: true })) {
			try {
				const s = await Bun.file(join(sessionsDir, f)).json() as { sessionId?: string; cwd?: string };
				if (!s.sessionId || !s.cwd) continue;
				const c = s.cwd.toLowerCase();
				const r = repoRoot.toLowerCase();
				if (c === r || c.startsWith(r + "/")) candidates.push(s.sessionId);
			} catch {}
		}
	} catch {} // ~/.claude/sessions/ may not exist on fresh installs

	if (candidates.length === 1) return candidates[0];

	// --- Fallback / tiebreaker: history.jsonl reverse scan ---
	const histPath = join(homedir(), ".claude", "history.jsonl");
	const histFile = Bun.file(histPath);
	if (!(await histFile.exists())) return candidates[0]; // undefined if no candidates

	const lines = (await histFile.text()).trim().split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const e = JSON.parse(lines[i]) as { sessionId?: string; project?: string; timestamp?: number };
			if (!e.sessionId || !e.project || !e.timestamp) continue;
			if (e.timestamp > commitTs + 60_000) continue; // prompt after commit — skip
			const p = e.project.toLowerCase();
			const r = repoRoot.toLowerCase();
			if (p !== r && !p.startsWith(r + "/") && !e.project.endsWith("/" + repoName)) continue;
			// If we have live candidates, prefer one that also appears in history
			if (candidates.length > 1 && !candidates.includes(e.sessionId)) continue;
			return e.sessionId;
		} catch {}
	}
	// Final fallback: if multiple live sessions but none in history (e.g. brand-new sessions
	// with no prompts yet), return the first candidate rather than silently dropping
	return candidates[0];
}

interface TokenSnapshot {
	cost: number;
	tokens: { input: number; output: number; cache_read: number; cache_write: number };
	messages: number;
}

async function run() {
	const repoRoot = await getRepoRoot();
	const repoName = projectName(repoRoot);
	const commit = await getCommitInfo();

	// Resolve the exact session active at commit time — no time window, no guessing
	const sessionId = await resolveSessionId(repoRoot, repoName, commit.timestamp);
	if (!sessionId) return; // No Claude session found — skip silently

	const ch = createHistory({ provider: "claude" });
	const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
	const allSessions = await ch.sessions.listWithMeta({ from: yesterday });
	const matched = allSessions.filter((s) => s.sessionId === sessionId);
	if (matched.length === 0) return; // Session found but not in recent history — skip

	// Aggregate full session totals
	const fullTokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
	let fullMessages = 0;
	const models = new Set<string>();

	for (const s of matched) {
		fullTokens.input += s.totalInputTokens;
		fullTokens.output += s.totalOutputTokens;
		fullTokens.cache_read += s.cacheReadInputTokens;
		fullTokens.cache_write += s.cacheCreationInputTokens;
		fullMessages += s.messageCount;
		if (s.model) models.add(s.model);
	}

	const fullCost = matched.reduce((sum, s) => sum + estimateCost(s), 0);

	// Find the highest session snapshot already attributed to this sessionId in prior records.
	// This lets us store only the DELTA since the last commit in this session — no double counting.
	const trackingPath = join(repoRoot, TRACKING_FILE);
	let prior: TokenSnapshot = { cost: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, messages: 0 };

	if (existsSync(trackingPath)) {
		for (const line of (await Bun.file(trackingPath).text()).trim().split("\n")) {
			try {
				const r = JSON.parse(line) as {
					session_ids?: string[];
					_session_snapshot?: TokenSnapshot;
					cost_usd?: number;
					tokens?: typeof fullTokens;
					messages?: number;
				};
				if (!r.session_ids?.includes(sessionId)) continue;
				if (r._session_snapshot && r._session_snapshot.cost > prior.cost) {
					prior = r._session_snapshot;
				} else if (!r._session_snapshot && r.session_ids.length === 1 && r.cost_usd !== undefined) {
					// Record written by an older version (no snapshot): cost_usd was the full session cost
					if (r.cost_usd > prior.cost) {
						prior = {
							cost: r.cost_usd,
							tokens: r.tokens ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 },
							messages: r.messages ?? 0,
						};
					}
				}
			} catch {}
		}
	}

	// Delta: only what was spent since the last commit in this session
	const tokens = {
		input: Math.max(0, fullTokens.input - prior.tokens.input),
		output: Math.max(0, fullTokens.output - prior.tokens.output),
		cache_read: Math.max(0, fullTokens.cache_read - prior.tokens.cache_read),
		cache_write: Math.max(0, fullTokens.cache_write - prior.tokens.cache_write),
	};
	const costUsd = Math.max(0, fullCost - prior.cost);
	const messages = Math.max(0, fullMessages - prior.messages);

	const record = {
		commit: commit.hash,
		timestamp: new Date(commit.timestamp).toISOString(),
		branch: commit.branch,
		author: commit.author,
		session_ids: matched.map((s) => s.sessionId),
		tokens,
		cost_usd: Math.round(costUsd * 100) / 100,
		models: [...models],
		messages,
		files_changed: commit.filesChanged,
		_session_snapshot: { cost: fullCost, tokens: fullTokens, messages: fullMessages },
	};

	// Append to tracking file
	await Bun.write(trackingPath, (existsSync(trackingPath) ? await Bun.file(trackingPath).text() : "") + JSON.stringify(record) + "\n");
}

// ── Init (backfill) ──────────────────────────────────────────────────

async function getCommitHistory(opts: { from?: string; to?: string } = {}): Promise<CommitInfo[]> {
	const since = opts.from ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
	const args = ["log", "--all", `--since=${since}`, "--format=%H\t%an\t%aI\t%at\t%s", "--shortstat"];
	if (opts.to) args.push(`--until=${opts.to}`);

	const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
	const text = await new Response(proc.stdout).text();
	await proc.exited;

	const commits: CommitInfo[] = [];
	const fullHashes: string[] = [];
	const lines = text.trim().split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line || !line.includes("\t")) continue;

		const parts = line.split("\t");
		if (parts.length < 5) continue;

		const [hash, author, , timestamp, message] = parts;

		let filesChanged = 0;
		// --shortstat puts a blank line between format and stat lines
		for (let j = 1; j <= 2; j++) {
			const peek = lines[i + j]?.trim() ?? "";
			const match = peek.match(/(\d+) files? changed/);
			if (match) {
				filesChanged = parseInt(match[1]);
				i += j;
				break;
			}
		}

		fullHashes.push(hash);
		commits.push({
			hash: hash.slice(0, 7),
			timestamp: parseInt(timestamp) * 1000,
			branch: "unknown",
			author,
			message,
			filesChanged,
		});
	}

	// Resolve per-commit branch in one batched git name-rev call (~18ms for 34 commits).
	// git log --format=%D only decorates ~9% of commits (branch tips); name-rev covers 100%.
	if (fullHashes.length > 0) {
		const nr = Bun.spawn(["git", "name-rev", "--always", "--exclude=HEAD", ...fullHashes], { stdout: "pipe", stderr: "pipe" });
		const nrText = await new Response(nr.stdout).text();
		await nr.exited;
		const refMap = new Map<string, string>();
		for (const line of nrText.trim().split("\n")) {
			const [h, ref] = line.trim().split(/\s+/);
			if (h && ref) {
				const base = ref.split(/[~^]/)[0]; // strip ~1, ^2 ancestor notation
				refMap.set(h, base.replace(/^remotes\/origin\//, "").replace(/^remotes\//, ""));
			}
		}
		for (let i = 0; i < commits.length; i++) {
			commits[i].branch = refMap.get(fullHashes[i]) ?? "unknown";
		}
	}

	return commits;
}

async function init(opts: { from?: string; to?: string } = {}) {
	const repoRoot = await getRepoRoot();
	const repoName = projectName(repoRoot);
	const trackingPath = join(repoRoot, TRACKING_FILE);

	// Load existing records to skip duplicates
	const existingHashes = new Set<string>();
	if (existsSync(trackingPath)) {
		const content = await Bun.file(trackingPath).text();
		for (const line of content.trim().split("\n")) {
			if (!line) continue;
			try {
				const rec = JSON.parse(line);
				if (rec.commit) existingHashes.add(rec.commit);
			} catch {}
		}
	}

	const commits = await getCommitHistory(opts);
	if (commits.length === 0) {
		console.log("No commits found in range.");
		return;
	}

	// Load sessions covering full commit range
	const earliest = new Date(Math.min(...commits.map((c) => c.timestamp)));
	const from = new Date(earliest.getTime() - 86400000).toISOString().slice(0, 10);
	const ch = createHistory({ provider: "claude" });
	const allSessions = await ch.sessions.listWithMeta({ from });

	// Filter to project
	const projectSessions = allSessions.filter((s) => isProjectMatch(s, repoRoot, repoName));

	// Count how many commits each session matches (for fair cost splitting)
	const sessionCommitCount = new Map<string, number>();
	const commitMatches = new Map<string, SessionMeta[]>();
	for (const commit of commits) {
		if (existingHashes.has(commit.hash)) continue;
		const matched = findMatchingSessions(commit.timestamp, projectSessions);
		if (matched.length === 0) continue;
		commitMatches.set(commit.hash, matched);
		for (const s of matched) {
			sessionCommitCount.set(s.sessionId, (sessionCommitCount.get(s.sessionId) ?? 0) + 1);
		}
	}

	const newRecords: string[] = [];
	let skippedNoAI = 0;
	let skippedExisting = 0;

	for (const commit of commits) {
		if (existingHashes.has(commit.hash)) {
			skippedExisting++;
			continue;
		}

		const matched = commitMatches.get(commit.hash);
		if (!matched) {
			skippedNoAI++;
			continue;
		}

		const tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
		let messages = 0;
		const models = new Set<string>();

		for (const s of matched) {
			const share = sessionCommitCount.get(s.sessionId) ?? 1;
			tokens.input += Math.round(s.totalInputTokens / share);
			tokens.output += Math.round(s.totalOutputTokens / share);
			tokens.cache_read += Math.round(s.cacheReadInputTokens / share);
			tokens.cache_write += Math.round(s.cacheCreationInputTokens / share);
			messages += Math.round(s.messageCount / share);
			if (s.model) models.add(s.model);
		}

		const costUsd = matched.reduce((sum, s) => {
			const share = sessionCommitCount.get(s.sessionId) ?? 1;
			return sum + estimateCost(s) / share;
		}, 0);

		newRecords.push(JSON.stringify({
			commit: commit.hash,
			timestamp: new Date(commit.timestamp).toISOString(),
			branch: commit.branch,
			author: commit.author,
			session_ids: matched.map((s) => s.sessionId),
			tokens,
			cost_usd: Math.round(costUsd * 100) / 100,
			models: [...models],
			messages,
			files_changed: commit.filesChanged,
		}));
	}

	// Append all new records at once
	if (newRecords.length > 0) {
		const existing = existsSync(trackingPath) ? await Bun.file(trackingPath).text() : "";
		await Bun.write(trackingPath, existing + newRecords.join("\n") + "\n");
	}

	console.log(`${newRecords.length} commits tracked, ${skippedNoAI} skipped (no AI), ${skippedExisting} already tracked`);
}

// ── CLI ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const command = argv[0];

function getArg(name: string): string | undefined {
	const idx = argv.indexOf(name);
	return idx !== -1 ? argv[idx + 1] : undefined;
}

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
	case "init":
		await init({ from: getArg("--from"), to: getArg("--to") });
		break;
	default:
		console.log(`Usage: bun examples/commit-tracker.ts <install|uninstall|run|init>

  install                  Install post-commit git hook in current repo
  uninstall                Remove the hook
  run                      Record AI usage for the latest commit (called by hook)
  init [--from] [--to]     Backfill .ai-usage.jsonl for existing commits (default: last 30 days)`);
}
