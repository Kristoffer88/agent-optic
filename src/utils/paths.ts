import { join } from "node:path";
import type { Provider } from "../types/provider.js";
import { DEFAULT_PROVIDER, defaultProviderDir } from "./providers.js";

/**
 * Reject session identifiers that could escape their provider directory when
 * interpolated into a filesystem path or glob pattern. Session data is only
 * semi-trusted (another tool or a crafted transcript can plant values), so any
 * id used to build a path must pass this guard first. Provider session IDs use
 * a deliberately small filename-safe alphabet; rejecting everything else avoids
 * platform-specific path and glob syntax that a blocklist could miss.
 */
export function isSafeSessionId(sessionId: string): boolean {
	return (
		typeof sessionId === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId) &&
		!sessionId.includes("..")
	);
}

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

/** Match bare filters against the short project name, and path-like filters against the full path. */
export function matchesProjectFilter(
	projectPath: string | undefined,
	shortName: string | undefined,
	filter: string | undefined,
): boolean {
	if (!filter) return true;
	const needle = filter.toLowerCase();
	const isPathLike = filter.includes("/") || filter.includes("\\") || filter.startsWith("~");
	return Boolean(
		isPathLike
			? projectPath?.toLowerCase().includes(needle)
			: shortName?.toLowerCase().includes(needle),
	);
}

/** Synthetic placeholder used when a session's project/cwd is not yet known. */
export function unknownProject(sessionId: string): string {
	return `(unknown)/${sessionId}`;
}

/** True for the synthetic `(unknown)/…` placeholder produced when no cwd is known. */
export function isUnknownProject(projectPath: string | undefined): boolean {
	return !projectPath || projectPath.startsWith("(unknown)");
}

interface ProviderPaths {
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

	if (provider === "pi") {
		const agentDir = join(base, "agent");
		return {
			base,
			historyFile: join(base, "history.jsonl"), // Pi has no history.jsonl — unused
			projectsDir: join(agentDir, "sessions"),
			sessionsDir: join(agentDir, "sessions"),
			globalStateFile: join(base, ".codex-global-state.json"),
			tasksDir: join(base, "tasks"),
			plansDir: join(base, "plans"),
			todosDir: join(base, "todos"),
			skillsDir: join(agentDir, "skills"),
			statsCache: join(base, "stats-cache.json"),
		};
	}

	if (provider === "copilot") {
		return {
			base,
			historyFile: join(base, "history.jsonl"), // Copilot has no history.jsonl — unused
			projectsDir: join(base, "session-state"),
			sessionsDir: join(base, "session-state"),
			globalStateFile: join(base, "global-state.json"),
			tasksDir: join(base, "tasks"),
			plansDir: join(base, "plans"),
			todosDir: join(base, "todos"),
			skillsDir: join(base, "skills"),
			statsCache: join(base, "stats-cache.json"),
		};
	}

	if (provider === "cursor") {
		return {
			base,
			historyFile: join(base, "history.jsonl"), // Cursor stores prompt history in workspace state.vscdb
			projectsDir: join(base, "workspaceStorage"),
			sessionsDir: join(base, "workspaceStorage"),
			globalStateFile: join(base, "globalStorage", "state.vscdb"),
			tasksDir: join(base, "tasks"),
			plansDir: join(base, "plans"),
			todosDir: join(base, "todos"),
			skillsDir: join(base, "skills"),
			statsCache: join(base, "stats-cache.json"),
		};
	}

	if (provider === "claude-desktop") {
		return {
			base,
			historyFile: join(base, "history.jsonl"), // Claude Desktop local agent mode has metadata JSON files
			projectsDir: join(base, "local-agent-mode-sessions"),
			sessionsDir: join(base, "local-agent-mode-sessions"),
			globalStateFile: join(base, "config.json"),
			tasksDir: join(base, "tasks"),
			plansDir: join(base, "plans"),
			todosDir: join(base, "todos"),
			skillsDir: join(base, "skills"),
			statsCache: join(base, "stats-cache.json"),
		};
	}

	if (provider === "opencode") {
		return {
			base,
			historyFile: join(base, "opencode.global.dat"),
			projectsDir: base,
			sessionsDir: base,
			globalStateFile: join(base, "opencode.global.dat"),
			tasksDir: join(base, "tasks"),
			plansDir: join(base, "plans"),
			todosDir: join(base, "todos"),
			skillsDir: join(base, "skills"),
			statsCache: join(base, "stats-cache.json"),
		};
	}

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

/** Decode a Pi project directory name: strip `--` bookends, `-` → `/`, prepend `/`. */
export function decodePiProjectPath(encoded: string): string {
	const inner = encoded.replace(/^--/, "").replace(/--$/, "");
	return "/" + inner.replace(/-/g, "/");
}
