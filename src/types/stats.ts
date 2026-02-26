/** Pre-computed stats from provider/stats-cache.json */
export interface StatsCache {
	version: number;
	lastComputedDate: string;
	dailyActivity: Array<{
		date: string;
		messageCount: number;
		sessionCount: number;
		toolCallCount: number;
	}>;
	totalSessions: number;
	totalMessages: number;
	hourCounts: Record<string, number>;
	modelUsage?: Record<string, number>;
}
