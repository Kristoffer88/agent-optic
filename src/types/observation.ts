import type { PrivacyProfile } from "./privacy.js";
import type { Provider } from "./provider.js";
import type {
	LifecycleMessageRole,
	LifecycleStopReason,
	SourceCapability,
} from "./session.js";

export type CanonicalObservationProvider = Exclude<Provider, "openai">;
export type ObservationAvailability = "available" | "partial" | "unavailable";
export type ObservationProviderStatus = "available" | "absent" | "error";
export type ObservationCapability =
	| "provider-health"
	| "bounded-sessions"
	| "bounded-prompts"
	| "privacy-profile"
	| "source-capabilities";

export interface ObservationProviderResult {
	provider: CanonicalObservationProvider;
	status: ObservationProviderStatus;
	sessionCount: number;
	error?: {
		code: "PROVIDER_STORE_ABSENT" | "PROVIDER_READ_FAILED";
		message: string;
	};
}

/** Exact session projection owned by agent-optic.observation/v1. */
export interface ObservedSession {
	provider: CanonicalObservationProvider;
	sessionId: string;
	project: string;
	projectName: string;
	prompts: string[];
	promptTimestamps: number[];
	timeRange: { start: number; end: number };
	lastFileActivity?: number;
	lastPrompt?: string;
	lastPromptTimestamp?: number;
	userPromptCount?: number;
	activityKind?: string;
	lastMessageRole?: LifecycleMessageRole;
	lastMessageStopReason?: LifecycleStopReason;
	lastMessageTimestamp?: number;
	dataCompleteness?: "full" | "prompt-only" | "metadata-only";
	sourceCapabilities?: SourceCapability[];
	gitBranch?: string;
	model?: string;
	totalInputTokens: number;
	totalOutputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
	messageCount: number;
	totalCost?: number;
}

export interface SessionObservation {
	schemaVersion: "agent-optic.observation/v1";
	generatedAt: string;
	availability: ObservationAvailability;
	capabilities: ObservationCapability[];
	completeness: {
		observedSessions: number;
		returnedSessions: number;
		truncated: boolean;
	};
	query: {
		providers: CanonicalObservationProvider[];
		privacy: PrivacyProfile;
		project?: string;
		date?: string;
		from?: string;
		to?: string;
		sinceMs?: number;
		maxSessions: number;
		maxPrompts: number;
		maxPromptChars: number;
	};
	providers: ObservationProviderResult[];
	sessions: ObservedSession[];
}

export interface SessionObservationOptions {
	providers: Provider[];
	privacy?: PrivacyProfile;
	providerDirs?: Partial<Record<Provider, string>>;
	project?: string;
	date?: string;
	from?: string;
	to?: string;
	sinceMs?: number;
	maxSessions?: number;
	maxPrompts?: number;
	maxPromptChars?: number;
}
