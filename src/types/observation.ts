import type { PrivacyProfile } from "./privacy.js";
import type { Provider } from "./provider.js";
import type { SessionMeta } from "./session.js";

export type ObservationAvailability = "available" | "partial" | "unavailable";
export type ObservationProviderStatus = "available" | "absent" | "error";

export interface ObservationProviderResult {
	provider: Provider;
	status: ObservationProviderStatus;
	sessionCount: number;
	error?: {
		code: "PROVIDER_STORE_ABSENT" | "PROVIDER_READ_FAILED";
		message: string;
	};
}

export interface ObservedSession extends SessionMeta {
	provider: Provider;
}

export interface SessionObservation {
	schemaVersion: "agent-optic.observation/v1";
	generatedAt: string;
	availability: ObservationAvailability;
	query: {
		providers: Provider[];
		privacy: PrivacyProfile;
		project?: string;
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
	from?: string;
	to?: string;
	sinceMs?: number;
	maxSessions?: number;
	maxPrompts?: number;
	maxPromptChars?: number;
}
