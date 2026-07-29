import type { PrivacyConfig, PrivacyProfile } from "../types/privacy.js";

// Credential patterns: match common API key/token/secret formats.
// Every pattern is a single (non-nested) quantifier over a character class, so
// matching stays linear — no catastrophic backtracking on adversarial input.
const CREDENTIAL_PATTERNS = [
	// Generic: "key"/"token"/"secret"/"password" followed by a long alphanumeric string
	/(?:key|token|secret|password|api_key|apikey|auth)["\s:=]+[A-Za-z0-9+/=_\-]{20,}/gi,
	// Bearer tokens
	/Bearer\s+[A-Za-z0-9+/=_\-\.]{20,}/g,
	// OpenAI / Anthropic secret keys (sk-, sk-proj-, sk-ant-api03-, sk-live-, …)
	/\bsk-[A-Za-z0-9_\-]{20,}/g,
	// JSON Web Tokens (header.payload.signature, base64url)
	/\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g,
	// PEM private key blocks (RSA/EC/OpenSSH/PKCS8)
	/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g,
	// AWS-style keys
	/(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}/g,
	// GitHub tokens
	/gh[pousr]_[A-Za-z0-9_]{36,}/g,
	// GitHub fine-grained PATs
	/github_pat_[A-Za-z0-9_]{22,}/g,
	// Slack tokens
	/\bxox[baprs]-[A-Za-z0-9\-]{10,}/g,
	// Google API keys
	/\bAIza[A-Za-z0-9_\-]{35}\b/g,
	// GitLab personal access tokens
	/\bglpat-[A-Za-z0-9_\-]{20,}/g,
	// npm access tokens
	/\bnpm_[A-Za-z0-9]{36}\b/g,
	// Generic hex secrets (32+ chars)
	/(?:secret|token|key)["\s:=]+[0-9a-f]{32,}/gi,
];

const EMAIL_PATTERN = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const IP_PATTERN = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;

const LOCAL_PROFILE: PrivacyConfig = {
	redactPrompts: false,
	redactAbsolutePaths: false,
	redactHomeDir: false,
	stripThinking: true,
	stripToolResults: true,
	redactPatterns: [],
	excludeProjects: [],
};

const SHAREABLE_PROFILE: PrivacyConfig = {
	...LOCAL_PROFILE,
	redactAbsolutePaths: true,
	redactHomeDir: true,
};

const STRICT_PROFILE: PrivacyConfig = {
	...SHAREABLE_PROFILE,
	redactPrompts: true,
	redactPatterns: [...CREDENTIAL_PATTERNS, EMAIL_PATTERN, IP_PATTERN],
};

export const PRIVACY_PROFILES: Record<PrivacyProfile, PrivacyConfig> = {
	local: LOCAL_PROFILE,
	shareable: SHAREABLE_PROFILE,
	strict: STRICT_PROFILE,
};

export function resolvePrivacyConfig(
	profile?: PrivacyProfile,
	overrides?: Partial<PrivacyConfig>,
): PrivacyConfig {
	const base = PRIVACY_PROFILES[profile ?? "local"];
	if (!overrides) return { ...base };
	return {
		...base,
		...overrides,
		// Merge arrays rather than replace
		redactPatterns: [
			...base.redactPatterns,
			...(overrides.redactPatterns ?? []),
		],
		excludeProjects: [
			...base.excludeProjects,
			...(overrides.excludeProjects ?? []),
		],
	};
}
