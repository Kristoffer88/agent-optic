import type { PrivacyConfig } from "../types/privacy.js";
import type { Provider } from "../types/provider.js";
import type { DailySummary } from "../types/aggregations.js";
import { readHistory } from "../readers/history-reader.js";
import { readTasks, readTodos } from "../readers/task-reader.js";
import { readPlans } from "../readers/plan-reader.js";
import { readProjectMemories } from "../readers/project-reader.js";
import { parseSessions } from "../parsers/session-detail.js";

interface DailyPaths {
	historyFile: string;
	projectsDir: string;
	sessionsDir: string;
	tasksDir: string;
	plansDir: string;
	todosDir: string;
}

/** Build a complete DailySummary for a single date. */
export async function buildDailySummary(
	provider: Provider,
	date: string,
	paths: DailyPaths,
	privacy: PrivacyConfig,
): Promise<DailySummary> {
	// Read history (fast)
	const sessionInfos = await readHistory(paths.historyFile, date, date, privacy, {
		provider,
		sessionsDir: paths.sessionsDir,
	});

	// Parse sessions into detailed + short
	const { detailed, short } = await parseSessions(
		provider,
		sessionInfos,
		{ projectsDir: paths.projectsDir, sessionsDir: paths.sessionsDir },
		privacy,
	);

	// Read tasks, plans, todos in parallel
	const [tasks, plans, todos] = await Promise.all([
		readTasks(paths.tasksDir, date, date),
		readPlans(paths.plansDir, date, date),
		readTodos(paths.todosDir, date, date),
	]);

	// Read project memories
	const projectPaths = [...new Set(sessionInfos.map((s) => s.project))];
	const projectMemory = await readProjectMemories(projectPaths, paths.projectsDir, provider);

	const projects = [...new Set(sessionInfos.map((s) => s.projectName))];
	const totalPrompts = sessionInfos.reduce((sum, s) => sum + s.prompts.length, 0);

	return {
		date,
		sessions: detailed,
		shortSessions: short,
		tasks,
		plans,
		todos,
		totalPrompts,
		totalSessions: sessionInfos.length,
		projects,
		projectMemory,
	};
}

/** Build DailySummary objects for a date range. */
export async function buildDailyRange(
	provider: Provider,
	from: string,
	to: string,
	paths: DailyPaths,
	privacy: PrivacyConfig,
): Promise<DailySummary[]> {
	const summaries: DailySummary[] = [];
	const start = new Date(from);
	const end = new Date(to);

	for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
		const dateStr = d.toISOString().slice(0, 10);
		const summary = await buildDailySummary(provider, dateStr, paths, privacy);
		// Only include days that have activity
		if (summary.totalSessions > 0 || summary.tasks.length > 0 || summary.plans.length > 0) {
			summaries.push(summary);
		}
	}

	return summaries;
}
