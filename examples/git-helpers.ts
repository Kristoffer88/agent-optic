/**
 * git-helpers.ts — Shared git utilities for agent-optic examples.
 */

import type { SessionMeta } from "../src/index.js";

/** Format a token count as a human-readable string (e.g. 21000 → "21K"). */
export function fmtTokens(n: number): string {
	if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
	return String(n);
}

/**
 * Parse git name-rev output into a commit-hash → branch-name map.
 * Resolves branch for every commit hash, covering 100% (vs ~9% from --format=%D).
 * Returns "unknown" for any hash that couldn't be resolved.
 */
export async function resolveCommitBranches(
	hashes: string[],
	cwd?: string,
): Promise<Map<string, string>> {
	const refMap = new Map<string, string>();
	if (hashes.length === 0) return refMap;

	const nr = Bun.spawn(
		["git", "name-rev", "--always", "--exclude=HEAD", ...hashes],
		{ cwd, stdout: "pipe", stderr: "pipe" },
	);
	const nrText = await new Response(nr.stdout).text();
	await nr.exited;

	for (const line of nrText.trim().split("\n")) {
		const [h, ref] = line.trim().split(/\s+/);
		if (h && ref) {
			const base = ref.split(/[~^]/)[0];
			refMap.set(h, base.replace(/^remotes\/origin\//, "").replace(/^remotes\//, ""));
		}
	}
	return refMap;
}

/**
 * Find sessions active around a commit's timestamp.
 * Prefers sessions on the same branch when branch info is available —
 * eliminates false matches when multiple sessions run concurrently on different branches.
 * Falls back to the full time-window set if no branch match is found.
 */
export function findMatchingSessions(
	commitTimestamp: number,
	commitBranch: string,
	sessions: SessionMeta[],
	windowMs: number,
): SessionMeta[] {
	const byTime = sessions.filter(
		(s) => s.timeRange.start <= commitTimestamp + windowMs && s.timeRange.end >= commitTimestamp - windowMs,
	);

	if (commitBranch && commitBranch !== "unknown") {
		const byBranch = byTime.filter((s) => s.gitBranch === commitBranch);
		if (byBranch.length > 0) return byBranch;
	}

	return byTime;
}
