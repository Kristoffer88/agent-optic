import { homedir } from "node:os";
import { join } from "node:path";
import type { Provider } from "../types/provider.js";

const PROVIDER_HOME_DIR: Record<Provider, string> = {
	claude: ".claude",
	codex: ".codex",
	openai: ".codex",
	cursor: ".cursor",
	windsurf: ".windsurf",
	pi: ".pi",
	copilot: ".copilot",
};

export const DEFAULT_PROVIDER: Provider = "claude";

export function defaultProviderDir(provider: Provider): string {
	return join(homedir(), PROVIDER_HOME_DIR[provider]);
}

export function isProvider(value: string): value is Provider {
	return value in PROVIDER_HOME_DIR;
}

export function canonicalProvider(provider: Provider): Exclude<Provider, "openai"> {
	if (provider === "openai") return "codex";
	return provider;
}

/**
 * Known AI agent commit emails and usernames.
 * Used to attribute commits from fully-automated agents (Cursor, Copilot SWE, Devin)
 * that lack a local session file. Sourced from git-ai's agent_detection.rs.
 */
export const AGENT_COMMIT_EMAILS: Record<string, string> = {
	"cursoragent@cursor.com": "cursor",
	"198982749+copilot@users.noreply.github.com": "github-copilot",
	"158243242+devin-ai-integration[bot]@users.noreply.github.com": "devin",
	"noreply@anthropic.com": "claude",
	"noreply@openai.com": "codex",
};

export const AGENT_COMMIT_USERNAMES: Record<string, string> = {
	"copilot-swe-agent[bot]": "github-copilot",
	"devin-ai-integration[bot]": "devin",
	"cursor[bot]": "cursor",
};

/**
 * Detect the AI tool that authored a commit based on its git author email or username.
 * Returns the tool name (e.g. "cursor", "github-copilot") or undefined if not a known agent.
 */
export function detectAgentFromCommit(email?: string, username?: string): string | undefined {
	if (email) {
		const byEmail = AGENT_COMMIT_EMAILS[email.toLowerCase()];
		if (byEmail) return byEmail;
	}
	if (username) {
		const byUsername = AGENT_COMMIT_USERNAMES[username.toLowerCase()];
		if (byUsername) return byUsername;
	}
	return undefined;
}
