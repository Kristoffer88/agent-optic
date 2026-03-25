// Main factory
export { createHistory } from "./agent-optic.js";
export type { History, HistoryConfig } from "./agent-optic.js";

// Provider types
export type { Provider } from "./types/provider.js";
export { SUPPORTED_PROVIDERS } from "./types/provider.js";

// Domain types
export type {
	HistoryEntry,
	SessionInfo,
	SessionMeta,
	SessionDetail,
	ToolCategory,
	ToolCallSummary,
} from "./types/session.js";
export type { ContentBlock, TranscriptEntry } from "./types/transcript.js";
export type { TaskInfo, TodoItem } from "./types/task.js";
export type { PlanInfo } from "./types/plan.js";
export type { ProjectInfo, ProjectMemory } from "./types/project.js";
export type { StatsCache } from "./types/stats.js";
export type {
	DailySummary,
	ProjectSummary,
	ToolUsageReport,
	DateFilter,
	SessionListFilter,
} from "./types/aggregations.js";
export type { PrivacyConfig, PrivacyProfile } from "./types/privacy.js";

// Privacy
export { PRIVACY_PROFILES, resolvePrivacyConfig } from "./privacy/config.js";

// Small public utilities
export { projectName } from "./utils/paths.js";
export { toLocalDate, today } from "./utils/dates.js";

// Pricing
export type { ModelPricing } from "./pricing.js";
export { MODEL_PRICING, getModelPricing, normalizeModelName, estimateCost, setPricing } from "./pricing.js";

// Provider utilities
export { detectAgentFromCommit, AGENT_COMMIT_EMAILS, AGENT_COMMIT_USERNAMES } from "./utils/providers.js";
