import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import type { PrivacyConfig } from "../types/privacy.js";
import type { ProjectInfo } from "../types/project.js";
import type { SessionDetail, SessionInfo, SessionMeta } from "../types/session.js";
import type { TranscriptEntry } from "../types/transcript.js";
import { isProjectExcluded, redactString, shouldRedactStrings, filterTranscriptEntry } from "../privacy/redact.js";
import { projectName } from "../utils/paths.js";
import { toLocalDate } from "../utils/dates.js";

interface CursorGeneration {
	unixMs?: number;
	generationUUID?: string;
	type?: string;
	textDescription?: string;
}

interface CursorWorkspace {
	id: string;
	path: string;
	project: string;
	projectName: string;
}

interface CursorGenerationSession {
	workspace: CursorWorkspace;
	generation: Required<Pick<CursorGeneration, "unixMs" | "generationUUID">> & CursorGeneration;
}

interface ItemRow {
	value: string | null;
}

const GENERATIONS_KEY = "aiService.generations";
const cursorGenerationCache = new Map<string, Promise<CursorGenerationSession[]>>();
const CURSOR_CAPABILITIES = ["prompt", "project", "timestamps"] as const;

function parseWorkspaceFolder(raw: unknown, fallback: string): string {
	if (typeof raw !== "string" || raw.length === 0) return fallback;
	if (raw.startsWith("file://")) {
		try {
			return fileURLToPath(raw);
		} catch {
			return raw;
		}
	}
	return raw;
}

async function readWorkspaceMetadata(workspaceDir: string): Promise<CursorWorkspace> {
	const id = basename(workspaceDir);
	const metadataFile = Bun.file(join(workspaceDir, "workspace.json"));
	let folder: unknown;
	if (await metadataFile.exists()) {
		try {
			folder = JSON.parse(await metadataFile.text())?.folder;
		} catch {
			// fall back to workspace id
		}
	}
	const project = parseWorkspaceFolder(folder, `(cursor-workspace)/${id}`);
	return {
		id,
		path: workspaceDir,
		project,
		projectName: projectName(project),
	};
}

async function listCursorWorkspaces(workspaceStorageDir: string): Promise<CursorWorkspace[]> {
	let entries: string[];
	try {
		entries = await readdir(workspaceStorageDir);
	} catch {
		return [];
	}

	const workspaces: CursorWorkspace[] = [];
	for (const entry of entries) {
		if (entry.startsWith(".")) continue;
		const workspaceDir = join(workspaceStorageDir, entry);
		const dbFile = Bun.file(join(workspaceDir, "state.vscdb"));
		if (!(await dbFile.exists())) continue;
		workspaces.push(await readWorkspaceMetadata(workspaceDir));
	}
	return workspaces;
}

function readItemValue(dbPath: string, key: string): string | undefined {
	let db: Database | undefined;
	try {
		db = new Database(dbPath, { readonly: true });
		const row = db
			.query("select value from ItemTable where key = ? limit 1")
			.get(key) as ItemRow | null;
		return typeof row?.value === "string" ? row.value : undefined;
	} catch {
		return undefined;
	} finally {
		db?.close();
	}
}

function parseGenerations(raw: string | undefined): CursorGeneration[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

async function readWorkspaceGenerations(
	workspace: CursorWorkspace,
): Promise<CursorGenerationSession[]> {
	const raw = readItemValue(join(workspace.path, "state.vscdb"), GENERATIONS_KEY);
	return parseGenerations(raw)
		.filter((generation): generation is CursorGenerationSession["generation"] =>
			typeof generation?.generationUUID === "string" &&
			typeof generation?.unixMs === "number"
		)
		.map((generation) => ({ workspace, generation }));
}

async function readAllCursorGenerations(
	workspaceStorageDir: string,
	privacy?: PrivacyConfig,
): Promise<CursorGenerationSession[]> {
	let promise = cursorGenerationCache.get(workspaceStorageDir);
	if (!promise) {
		promise = (async () => {
			const workspaces = await listCursorWorkspaces(workspaceStorageDir);
			const all: CursorGenerationSession[] = [];

			for (const workspace of workspaces) {
				all.push(...await readWorkspaceGenerations(workspace));
			}

			return all.sort((a, b) => a.generation.unixMs - b.generation.unixMs);
		})();
		cursorGenerationCache.set(workspaceStorageDir, promise);
	}

	const all = await promise;
	return privacy
		? all.filter((entry) => !isProjectExcluded(entry.workspace.project, privacy))
		: all;
}

function generationPrompt(generation: CursorGeneration, privacy: PrivacyConfig): string {
	const text = generation.textDescription?.trim() || "(no prompt)";
	if (privacy.redactPrompts) return "[redacted]";
	if (shouldRedactStrings(privacy)) return redactString(text, privacy);
	return text;
}

function displayProject(project: string, privacy: PrivacyConfig): string {
	return shouldRedactStrings(privacy) ? redactString(project, privacy) : project;
}

// Read Cursor sessions from workspace state.vscdb aiService.generations.
export async function readCursorHistory(
	workspaceStorageDir: string,
	from: string,
	to: string,
	privacy: PrivacyConfig,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	const generations = await readAllCursorGenerations(workspaceStorageDir, privacy);

	for (const { workspace, generation } of generations) {
		const date = toLocalDate(generation.unixMs);
		if (date < from || date > to) continue;

		const project = displayProject(workspace.project, privacy);
		sessions.push({
			sessionId: generation.generationUUID,
			project,
			projectName: projectName(project),
			prompts: [generationPrompt(generation, privacy)],
			promptTimestamps: [generation.unixMs],
			timeRange: { start: generation.unixMs, end: generation.unixMs },
			dataCompleteness: "prompt-only",
			sourceCapabilities: [...CURSOR_CAPABILITIES],
		});
	}

	return sessions;
}

async function findCursorGeneration(
	workspaceStorageDir: string,
	sessionId: string,
	privacy?: PrivacyConfig,
): Promise<CursorGenerationSession | undefined> {
	const generations = await readAllCursorGenerations(workspaceStorageDir, privacy);
	return generations.find((entry) => entry.generation.generationUUID === sessionId);
}

/** Peek Cursor session metadata. Cursor prompt history has no token/model detail. */
export async function peekCursorSession(
	session: SessionInfo,
	workspaceStorageDir: string,
): Promise<SessionMeta> {
	const found = await findCursorGeneration(workspaceStorageDir, session.sessionId);
	const timestamp = found?.generation.unixMs ?? session.timeRange.start;
	return {
		...session,
		timeRange: { start: timestamp, end: timestamp },
		totalInputTokens: 0,
		totalOutputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
		messageCount: 1,
	};
}

/** Parse Cursor session detail. Current local records expose prompt-level history only. */
export async function parseCursorSessionDetail(
	session: SessionInfo,
	workspaceStorageDir: string,
	privacy: PrivacyConfig,
): Promise<SessionDetail> {
	const found = await findCursorGeneration(workspaceStorageDir, session.sessionId, privacy);
	const effectiveSession = found
		? {
				sessionId: found.generation.generationUUID,
				project: displayProject(found.workspace.project, privacy),
				projectName: projectName(displayProject(found.workspace.project, privacy)),
				prompts: [generationPrompt(found.generation, privacy)],
				promptTimestamps: [found.generation.unixMs],
				timeRange: { start: found.generation.unixMs, end: found.generation.unixMs },
				dataCompleteness: "prompt-only" as const,
				sourceCapabilities: [...CURSOR_CAPABILITIES],
			}
		: session;

	return {
		...effectiveSession,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
		messageCount: effectiveSession.prompts.length,
		assistantSummaries: [],
		toolCalls: [],
		filesReferenced: [],
		planReferenced: false,
		thinkingBlockCount: 0,
		hasSidechains: false,
	};
}

/** Stream Cursor transcript entries. Current local records expose the user prompt only. */
export async function* streamCursorTranscript(
	sessionId: string,
	workspaceStorageDir: string,
	privacy: PrivacyConfig,
): AsyncGenerator<TranscriptEntry> {
	const found = await findCursorGeneration(workspaceStorageDir, sessionId, privacy);
	if (!found) return;

	const mapped: TranscriptEntry = {
		type: "user",
		timestamp: new Date(found.generation.unixMs).toISOString(),
		cwd: displayProject(found.workspace.project, privacy),
		sessionId: found.generation.generationUUID,
		message: {
			role: "user",
			content: generationPrompt(found.generation, privacy),
		},
	};

	const filtered = filterTranscriptEntry(mapped, privacy);
	if (filtered) yield filtered;
}

/** List Cursor workspaces as projects, with generation counts per workspace. */
export async function readCursorProjects(
	workspaceStorageDir: string,
	privacy: PrivacyConfig,
): Promise<ProjectInfo[]> {
	const workspaces = await listCursorWorkspaces(workspaceStorageDir);
	const projects: ProjectInfo[] = [];

	for (const workspace of workspaces) {
		if (isProjectExcluded(workspace.project, privacy)) continue;
		const generations = await readWorkspaceGenerations(workspace);
		const project = displayProject(workspace.project, privacy);
		projects.push({
			encodedPath: workspace.id,
			decodedPath: project,
			name: projectName(project),
			sessionCount: generations.length,
			hasMemory: false,
		});
	}

	return projects.sort((a, b) => b.sessionCount - a.sessionCount);
}
