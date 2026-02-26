import { homedir } from "node:os";
import { join } from "node:path";
import type { Provider } from "../types/provider.js";

const PROVIDER_HOME_DIR: Record<Provider, string> = {
	claude: ".claude",
	codex: ".codex",
	cursor: ".cursor",
	windsurf: ".windsurf",
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
