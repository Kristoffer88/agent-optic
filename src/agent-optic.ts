import type { PrivacyConfig, PrivacyProfile } from "./types/privacy.js";
import type { SessionInfo, SessionMeta, SessionDetail } from "./types/session.js";
import type { TranscriptEntry } from "./types/transcript.js";
import type { TaskInfo, TodoItem } from "./types/task.js";
import type { PlanInfo } from "./types/plan.js";
import type { ProjectInfo, ProjectMemory } from "./types/project.js";
import type { StatsCache } from "./types/stats.js";
import type { Provider } from "./types/provider.js";
import type {
	DailySummary,
	ProjectSummary,
	ToolUsageReport,
	DateFilter,
	SessionListFilter,
} from "./types/aggregations.js";

import { providerPaths } from "./utils/paths.js";
import { resolveDateRange } from "./utils/dates.js";
import { canonicalProvider } from "./utils/providers.js";
import { resolvePrivacyConfig } from "./privacy/config.js";
import { setPricing, type ModelPricing } from "./pricing.js";

import { readHistory } from "./readers/history-reader.js";
import { peekSession, streamTranscript } from "./readers/session-reader.js";
import { readTasks, readTodos } from "./readers/task-reader.js";
import { readPlans } from "./readers/plan-reader.js";
import { readProjects, readProjectMemory } from "./readers/project-reader.js";
import { readStats } from "./readers/stats-reader.js";
import { readSkills, readSkillContent } from "./readers/skill-reader.js";

import { parseSessionDetail } from "./parsers/session-detail.js";

import { buildDailySummary, buildDailyRange } from "./aggregations/daily.js";
import { buildProjectSummaries } from "./aggregations/project.js";
import { buildToolUsageReport } from "./aggregations/tools.js";
import { estimateHours } from "./aggregations/time.js";

export interface HistoryConfig {
	/** Assistant provider. Defaults to "claude". */
	provider?: Provider;
	/** Path to provider data directory. Defaults to provider-specific home folder. */
	providerDir?: string;
	/** Privacy profile name or partial config. Defaults to "local" */
	privacy?: PrivacyProfile | Partial<PrivacyConfig>;
	/** Enable caching of repeated reads. Defaults to true */
	cache?: boolean;
	/** Override or extend model pricing (USD per million tokens). Merges with built-in defaults. */
	pricing?: Record<string, ModelPricing>;
}

export interface History {
	sessions: {
		/** Fast: reads only history.jsonl */
		list(filter?: SessionListFilter): Promise<SessionInfo[]>;
		/** Medium: also peeks session files for branch/model/tokens */
		listWithMeta(filter?: SessionListFilter): Promise<SessionMeta[]>;
		/** Full: parses entire session JSONL */
		detail(sessionId: string, projectPath?: string): Promise<SessionDetail>;
		/** Streaming: yields transcript entries one at a time */
		transcript(sessionId: string, projectPath?: string): AsyncGenerator<TranscriptEntry>;
		/** Count sessions matching filter */
		count(filter?: SessionListFilter): Promise<number>;
	};
	projects: {
		list(): Promise<ProjectInfo[]>;
		memory(projectPath: string): Promise<ProjectMemory | null>;
	};
	tasks: {
		list(filter: DateFilter): Promise<TaskInfo[]>;
	};
	todos: {
		list(filter: DateFilter): Promise<TodoItem[]>;
	};
	plans: {
		list(filter: DateFilter): Promise<PlanInfo[]>;
	};
	skills: {
		list(): Promise<string[]>;
		read(name: string): Promise<string>;
	};
	stats: {
		get(): Promise<StatsCache | null>;
	};
	aggregate: {
		daily(date: string): Promise<DailySummary>;
		dailyRange(from: string, to: string): Promise<DailySummary[]>;
		byProject(filter?: SessionListFilter): Promise<ProjectSummary[]>;
		toolUsage(filter?: SessionListFilter): Promise<ToolUsageReport>;
		estimateHours(sessions: SessionInfo[]): number;
	};
}

/** Create a provider-aware History instance for reading session data. */
export function createHistory(config?: HistoryConfig): History {
	const requestedProvider = config?.provider ?? "claude";
	const provider = canonicalProvider(requestedProvider);
	const paths = providerPaths({
		provider: requestedProvider,
		providerDir: config?.providerDir,
	});

	if (config?.pricing) {
		setPricing(config.pricing);
	}

	const privacy: PrivacyConfig =
		typeof config?.privacy === "string"
			? resolvePrivacyConfig(config.privacy)
			: resolvePrivacyConfig(undefined, config?.privacy);

	const dailyPaths = {
		historyFile: paths.historyFile,
		projectsDir: paths.projectsDir,
		sessionsDir: paths.sessionsDir,
		tasksDir: paths.tasksDir,
		plansDir: paths.plansDir,
		todosDir: paths.todosDir,
	};

	return {
		sessions: {
			async list(filter?: SessionListFilter): Promise<SessionInfo[]> {
				const { from, to } = resolveDateRange(filter);
				let sessions = await readHistory(paths.historyFile, from, to, privacy, {
					provider,
					sessionsDir: paths.sessionsDir,
				});

				if (filter?.project) {
					const f = filter.project.toLowerCase();
					sessions = sessions.filter((s) => s.projectName.toLowerCase().includes(f));
				}

				return sessions;
			},

			async listWithMeta(filter?: SessionListFilter): Promise<SessionMeta[]> {
				const { from, to } = resolveDateRange(filter);
				let sessions = await readHistory(paths.historyFile, from, to, privacy, {
					provider,
					sessionsDir: paths.sessionsDir,
				});

				if (filter?.project) {
					const f = filter.project.toLowerCase();
					sessions = sessions.filter((s) => s.projectName.toLowerCase().includes(f));
				}

				return Promise.all(
					sessions.map((s) =>
						peekSession(provider, s, {
							projectsDir: paths.projectsDir,
							sessionsDir: paths.sessionsDir,
						}, privacy),
					),
				);
			},

			async detail(sessionId: string, projectPath?: string): Promise<SessionDetail> {
				let session: SessionInfo | undefined;

				if (!projectPath || provider === "codex") {
					const all = await readHistory(
						paths.historyFile,
						"2000-01-01",
						"2099-12-31",
						privacy,
						{
							provider,
							sessionsDir: paths.sessionsDir,
						},
					);
					session = all.find((s) => s.sessionId === sessionId);
				}

				if (!session) {
					const effectiveProjectPath = projectPath ?? `(unknown)/${sessionId}`;
					session = {
						sessionId,
						project: effectiveProjectPath,
						projectName:
							effectiveProjectPath.split("/").pop() || effectiveProjectPath,
						prompts: [],
						promptTimestamps: [],
						timeRange: { start: 0, end: 0 },
					};
				}

				return parseSessionDetail(provider, session, {
					projectsDir: paths.projectsDir,
					sessionsDir: paths.sessionsDir,
				}, privacy);
			},

			async *transcript(
				sessionId: string,
				projectPath?: string,
			): AsyncGenerator<TranscriptEntry> {
				yield* streamTranscript(
					provider,
					sessionId,
					projectPath ?? `(unknown)/${sessionId}`,
					{
						projectsDir: paths.projectsDir,
						sessionsDir: paths.sessionsDir,
					},
					privacy,
				);
			},

			async count(filter?: SessionListFilter): Promise<number> {
				const { from, to } = resolveDateRange(filter);
				const sessions = await readHistory(paths.historyFile, from, to, privacy, {
					provider,
					sessionsDir: paths.sessionsDir,
				});
				if (filter?.project) {
					const f = filter.project.toLowerCase();
					return sessions.filter((s) => s.projectName.toLowerCase().includes(f)).length;
				}
				return sessions.length;
			},
		},

		projects: {
			async list(): Promise<ProjectInfo[]> {
				return readProjects(paths.projectsDir, privacy);
			},

			async memory(projectPath: string): Promise<ProjectMemory | null> {
				return readProjectMemory(projectPath, paths.projectsDir);
			},
		},

		tasks: {
			async list(filter: DateFilter): Promise<TaskInfo[]> {
				const { from, to } = resolveDateRange(filter);
				return readTasks(paths.tasksDir, from, to);
			},
		},

		todos: {
			async list(filter: DateFilter): Promise<TodoItem[]> {
				const { from, to } = resolveDateRange(filter);
				return readTodos(paths.todosDir, from, to);
			},
		},

		plans: {
			async list(filter: DateFilter): Promise<PlanInfo[]> {
				const { from, to } = resolveDateRange(filter);
				return readPlans(paths.plansDir, from, to);
			},
		},

		skills: {
			async list(): Promise<string[]> {
				return readSkills(paths.skillsDir);
			},

			async read(name: string): Promise<string> {
				return readSkillContent(paths.skillsDir, name);
			},
		},

		stats: {
			async get(): Promise<StatsCache | null> {
				return readStats(paths.statsCache);
			},
		},

		aggregate: {
			async daily(date: string): Promise<DailySummary> {
				return buildDailySummary(provider, date, dailyPaths, privacy);
			},

			async dailyRange(from: string, to: string): Promise<DailySummary[]> {
				return buildDailyRange(provider, from, to, dailyPaths, privacy);
			},

			async byProject(filter?: SessionListFilter): Promise<ProjectSummary[]> {
				return buildProjectSummaries(
					provider,
					filter ?? {},
					paths.historyFile,
					{ projectsDir: paths.projectsDir, sessionsDir: paths.sessionsDir },
					privacy,
				);
			},

			async toolUsage(filter?: SessionListFilter): Promise<ToolUsageReport> {
				return buildToolUsageReport(
					provider,
					filter ?? {},
					paths.historyFile,
					{ projectsDir: paths.projectsDir, sessionsDir: paths.sessionsDir },
					privacy,
				);
			},

			estimateHours(sessions: SessionInfo[]): number {
				return estimateHours(sessions);
			},
		},
	};
}

/** Backward-compatible Claude-specific config. */
export interface ClaudeHistoryConfig extends Omit<HistoryConfig, "provider" | "providerDir"> {
	/** Path to ~/.claude directory. Defaults to ~/.claude */
	claudeDir?: string;
}

/** Backward-compatible Claude-specific alias. */
export type ClaudeHistory = History;

/** Create a ClaudeHistory instance for reading session data. */
export function createClaudeHistory(config?: ClaudeHistoryConfig): ClaudeHistory {
	const { claudeDir, ...rest } = config ?? {};
	return createHistory({
		...rest,
		provider: "claude",
		providerDir: claudeDir,
	});
}
