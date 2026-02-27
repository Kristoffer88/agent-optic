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
};

export const DEFAULT_PROVIDER: Provider = "claude";

export function defaultProviderDir(provider: Provider): string {
	return join(homedir(), PROVIDER_HOME_DIR[provider]);
}

export function providerHomeDirName(provider: Provider): string {
	return PROVIDER_HOME_DIR[provider];
}

export function isProvider(value: string): value is Provider {
	return value in PROVIDER_HOME_DIR;
}

export function canonicalProvider(provider: Provider): Exclude<Provider, "openai"> {
	if (provider === "openai") return "codex";
	return provider;
}
