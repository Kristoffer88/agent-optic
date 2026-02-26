import { join } from "node:path";
import type { Provider } from "../types/provider.js";
import { DEFAULT_PROVIDER, defaultProviderDir } from "./providers.js";

/** Encode a project path for filesystem storage (/ → -). */
export function encodeProjectPath(projectPath: string): string {
	return projectPath.replace(/\//g, "-");
}

/** Decode an encoded project path back to original (- → /). Best-effort: ambiguous. */
export function decodeProjectPath(encoded: string): string {
	return encoded.replace(/-/g, "/");
}

/** Extract a short project name from a full path. */
export function projectName(projectPath: string): string {
	return projectPath.split("/").pop() || projectPath;
}

export interface ProviderPaths {
	base: string;
	historyFile: string;
	projectsDir: string;
	sessionsDir: string;
	globalStateFile: string;
	tasksDir: string;
	plansDir: string;
	todosDir: string;
	skillsDir: string;
	statsCache: string;
}

/** Build all standard paths relative to a provider directory. */
export function providerPaths(config?: {
	provider?: Provider;
	providerDir?: string;
}): ProviderPaths {
	const provider = config?.provider ?? DEFAULT_PROVIDER;
	const base = config?.providerDir ?? defaultProviderDir(provider);
	return {
		base,
		historyFile: join(base, "history.jsonl"),
		projectsDir: join(base, "projects"),
		sessionsDir: join(base, "sessions"),
		globalStateFile: join(base, ".codex-global-state.json"),
		tasksDir: join(base, "tasks"),
		plansDir: join(base, "plans"),
		todosDir: join(base, "todos"),
		skillsDir: join(base, "skills"),
		statsCache: join(base, "stats-cache.json"),
	};
}

/** Backward-compatible alias for Claude-specific default paths. */
export function claudePaths(claudeDir?: string): ProviderPaths {
	return providerPaths({ provider: "claude", providerDir: claudeDir });
}
