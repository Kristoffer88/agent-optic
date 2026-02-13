import type { SessionInfo } from "../types/session.js";

/** Gap cap in ms — if gap between consecutive prompts exceeds this, cap it. */
const GAP_CAP_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Estimate hours of active work from session timestamp data.
 * Merges all timestamps across sessions into a single sorted timeline,
 * then applies gap-capping. This deduplicates overlapping intervals so
 * concurrent sessions (e.g. multiple terminal tabs) share wall-clock time
 * instead of stacking it.
 */
export function estimateHours(sessions: SessionInfo[]): number {
	if (sessions.length === 0) return 0;

	// Merge all timestamps across sessions into a single timeline
	const allTimestamps: number[] = [];

	for (const session of sessions) {
		if (session.promptTimestamps.length > 0) {
			allTimestamps.push(...session.promptTimestamps);
		} else {
			// Sessions with no prompt timestamps: use start/end
			const ts = [session.timeRange.start, session.timeRange.end].filter(t => t > 0);
			allTimestamps.push(...ts);
		}
	}

	if (allTimestamps.length === 0) return 0;

	allTimestamps.sort((a, b) => a - b);

	if (allTimestamps.length === 1) {
		return 5 / 60; // Single timestamp → 5 minutes
	}

	let totalMs = 0;
	for (let i = 1; i < allTimestamps.length; i++) {
		const gap = allTimestamps[i] - allTimestamps[i - 1];
		totalMs += Math.min(gap, GAP_CAP_MS);
	}

	return totalMs / (1000 * 60 * 60);
}
