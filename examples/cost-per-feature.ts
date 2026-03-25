#!/usr/bin/env bun
/**
 * cost-per-feature.ts — Match assistant sessions to git branches and calculate cost per feature.
 *
 * Usage:
 *   bun examples/cost-per-feature.ts [--repo /path/to/repo] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *
 * Reads git log from the specified repo (or cwd) and matches branches to sessions
 * that were active on those branches. Outputs a cost breakdown per feature/branch.
 */

import { createHistory, estimateCost, type SessionMeta } from "../src/index.js";

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
	const idx = args.indexOf(name);
	return idx !== -1 ? args[idx + 1] : undefined;
}

const repoPath = getArg("--repo") ?? process.cwd();
const from = getArg("--from") ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const to = getArg("--to");
const topN = parseInt(getArg("--top") ?? "0") || 0;

interface BranchInfo {
	branch: string;
	commits: number;
	lastCommit: string;
}

async function getGitBranches(): Promise<BranchInfo[]> {
	const proc = Bun.spawn(
		["git", "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)\t%(committerdate:iso)", "refs/heads/"],
		{ cwd: repoPath, stdout: "pipe", stderr: "pipe" },
	);
	const text = await new Response(proc.stdout).text();
	await proc.exited;

	const branches: BranchInfo[] = [];
	for (const line of text.trim().split("\n")) {
		if (!line) continue;
		const [branch, lastCommit] = line.split("\t");

		const base = await getDefaultBranch();
		const countProc = Bun.spawn(
			["git", "rev-list", "--count", `${base}..${branch}`],
			{ cwd: repoPath, stdout: "pipe", stderr: "pipe" },
		);
		const countText = await new Response(countProc.stdout).text();
		await countProc.exited;
		const commits = parseInt(countText.trim()) || 0;

		branches.push({ branch, commits, lastCommit: lastCommit?.trim() ?? "" });
	}
	return branches;
}

async function getDefaultBranch(): Promise<string> {
	const proc = Bun.spawn(
		["git", "symbolic-ref", "--short", "HEAD"],
		{ cwd: repoPath, stdout: "pipe", stderr: "pipe" },
	);
	const text = await new Response(proc.stdout).text();
	await proc.exited;

	const current = text.trim();
	for (const candidate of ["main", "master"]) {
		const check = Bun.spawn(
			["git", "rev-parse", "--verify", candidate],
			{ cwd: repoPath, stdout: "pipe", stderr: "pipe" },
		);
		await check.exited;
		if (check.exitCode === 0) return candidate;
	}
	return current;
}

async function main() {
	const ch = createHistory({ provider: "claude" });
	const sessions = await ch.sessions.listWithMeta({ from, to });

	// Group sessions by project, then by branch within each project
	interface ProjectGroup {
		sessions: SessionMeta[];
		byBranch: Map<string, SessionMeta[]>;
		unmatched: SessionMeta[];
	}
	const byProject = new Map<string, ProjectGroup>();

	for (const s of sessions) {
		const project = s.projectName || "(unknown project)";
		if (!byProject.has(project)) {
			byProject.set(project, { sessions: [], byBranch: new Map(), unmatched: [] });
		}
		const pg = byProject.get(project)!;
		pg.sessions.push(s);

		const branch = s.gitBranch ?? "unknown";
		if (branch === "unknown") {
			pg.unmatched.push(s);
		} else {
			const list = pg.byBranch.get(branch) ?? [];
			list.push(s);
			pg.byBranch.set(branch, list);
		}
	}

	let gitBranches: BranchInfo[] = [];
	try {
		gitBranches = await getGitBranches();
	} catch {
		// Not in a git repo
	}
	const commitMap = new Map(gitBranches.map((b) => [b.branch, b.commits]));

	interface FeatureCost {
		branch: string;
		sessions: number;
		inputTokens: number;
		outputTokens: number;
		cacheTokens: number;
		cost: number;
		commits: number;
	}

	function buildFeatures(byBranch: Map<string, SessionMeta[]>): FeatureCost[] {
		const features: FeatureCost[] = [];
		for (const [branch, branchSessions] of byBranch) {
			const cost = branchSessions.reduce((sum, s) => sum + estimateCost(s), 0);
			features.push({
				branch,
				sessions: branchSessions.length,
				inputTokens: branchSessions.reduce((s, x) => s + x.totalInputTokens, 0),
				outputTokens: branchSessions.reduce((s, x) => s + x.totalOutputTokens, 0),
				cacheTokens: branchSessions.reduce((s, x) => s + x.cacheCreationInputTokens + x.cacheReadInputTokens, 0),
				cost,
				commits: commitMap.get(branch) ?? 0,
			});
		}
		features.sort((a, b) => b.cost - a.cost);
		return features;
	}

	// Sort projects by total cost descending
	const sortedProjects = [...byProject.entries()].sort((a, b) => {
		const costA = a[1].sessions.reduce((s, x) => s + estimateCost(x), 0);
		const costB = b[1].sessions.reduce((s, x) => s + estimateCost(x), 0);
		return costB - costA;
	});

	const W = 90;
	console.log("Cost per Feature / Branch (by Project)");
	console.log("=".repeat(W));

	let grandTotal = 0;
	let grandSessions = 0;

	const shownProjects = topN > 0 ? sortedProjects.slice(0, topN) : sortedProjects;
	const collapsedProjects = topN > 0 ? sortedProjects.slice(topN) : [];

	for (const [project, pg] of shownProjects) {
		const projectCost = pg.sessions.reduce((s, x) => s + estimateCost(x), 0);
		grandTotal += projectCost;
		grandSessions += pg.sessions.length;

		console.log("");
		console.log(`  ${project}  (${pg.sessions.length} sessions, $${projectCost.toFixed(2)})`);
		console.log("  " + "-".repeat(W - 2));

		const features = buildFeatures(pg.byBranch);
		for (const f of features) {
			const tokens = f.inputTokens + f.outputTokens + f.cacheTokens;
			console.log(
				("    " + f.branch.slice(0, 30)).padEnd(35),
				String(f.sessions).padStart(10),
				formatTokens(tokens).padStart(12),
				`$${f.cost.toFixed(2)}`.padStart(12),
				String(f.commits).padStart(10),
			);
		}

		if (pg.unmatched.length > 0) {
			const tokens = pg.unmatched.reduce((s, x) => s + x.totalInputTokens + x.totalOutputTokens + x.cacheCreationInputTokens + x.cacheReadInputTokens, 0);
			const unmatchedCost = pg.unmatched.reduce((s, x) => s + estimateCost(x), 0);
			console.log(
				"    (no branch)".padEnd(35),
				String(pg.unmatched.length).padStart(10),
				formatTokens(tokens).padStart(12),
				`$${unmatchedCost.toFixed(2)}`.padStart(12),
				"-".padStart(10),
			);
		}
	}

	if (collapsedProjects.length > 0) {
		let collapsedSessions = 0;
		let collapsedCost = 0;
		for (const [, pg] of collapsedProjects) {
			const cost = pg.sessions.reduce((s, x) => s + estimateCost(x), 0);
			collapsedSessions += pg.sessions.length;
			collapsedCost += cost;
			grandTotal += cost;
			grandSessions += pg.sessions.length;
		}
		console.log("");
		console.log(
			`  ... ${collapsedProjects.length} more projects`.padEnd(35),
			String(collapsedSessions).padStart(10),
			"".padStart(12),
			`$${collapsedCost.toFixed(2)}`.padStart(12),
			"".padStart(10),
		);
	}

	console.log("");
	console.log("=".repeat(W));
	console.log(
		"TOTAL".padEnd(35),
		String(grandSessions).padStart(10),
		"".padStart(12),
		`$${grandTotal.toFixed(2)}`.padStart(12),
		"".padStart(10),
	);
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

main().catch(console.error);
