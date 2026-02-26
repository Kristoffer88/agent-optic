import { join } from "node:path";

interface CodexSessionHeader {
	cwd?: string;
	gitBranch?: string;
	model?: string;
	modelProvider?: string;
}

const rolloutIndexCache = new Map<string, Promise<Map<string, string>>>();
const headerCache = new Map<string, Promise<CodexSessionHeader>>();

function parseRolloutFilename(
	filename: string,
): { date: string; sessionId: string } | null {
	const m = filename.match(
		/^rollout-(\d{4}-\d{2}-\d{2})T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/,
	);
	return m ? { date: m[1], sessionId: m[2] } : null;
}

async function buildRolloutIndex(sessionsDir: string): Promise<Map<string, string>> {
	const index = new Map<string, string>();
	const glob = new Bun.Glob("**/*.jsonl");
	for await (const path of glob.scan({
		cwd: sessionsDir,
		absolute: false,
	})) {
		const filename = path.split("/").pop()!;
		const parsed = parseRolloutFilename(filename);
		if (parsed) index.set(parsed.sessionId, join(sessionsDir, path));
	}
	return index;
}

async function getRolloutIndex(sessionsDir: string): Promise<Map<string, string>> {
	let promise = rolloutIndexCache.get(sessionsDir);
	if (!promise) {
		promise = buildRolloutIndex(sessionsDir);
		rolloutIndexCache.set(sessionsDir, promise);
	}
	return promise;
}

export async function findRolloutFile(
	sessionsDir: string,
	sessionId: string,
): Promise<string | null> {
	const index = await getRolloutIndex(sessionsDir);
	const cached = index.get(sessionId);
	if (cached) return cached;

	// Fallback for newly created files before cache refresh.
	const glob = new Bun.Glob(`**/*-${sessionId}.jsonl`);
	for await (const path of glob.scan({
		cwd: sessionsDir,
		absolute: false,
	})) {
		const fullPath = join(sessionsDir, path);
		index.set(sessionId, fullPath);
		return fullPath;
	}
	return null;
}

export async function readCodexSessionHeader(
	sessionsDir: string,
	sessionId: string,
): Promise<CodexSessionHeader> {
	const key = `${sessionsDir}:${sessionId}`;
	let promise = headerCache.get(key);
	if (!promise) {
		promise = (async () => {
			const rolloutPath = await findRolloutFile(sessionsDir, sessionId);
			if (!rolloutPath) return {};

			const file = Bun.file(rolloutPath);
			if (!(await file.exists())) return {};

			let cwd: string | undefined;
			let gitBranch: string | undefined;
			let model: string | undefined;
			let modelProvider: string | undefined;

			try {
				const text = await file.text();
				for (const line of text.split("\n")) {
					if (!line.trim()) continue;
					let entry: any;
					try {
						entry = JSON.parse(line);
					} catch {
						continue;
					}

					if (entry.type === "session_meta") {
						cwd = entry.payload?.cwd;
						gitBranch = entry.payload?.git?.branch;
						modelProvider = entry.payload?.model_provider;
					} else if (entry.type === "turn_context") {
						model = entry.payload?.model;
					}

					if (cwd && model) break;
				}
			} catch {
				return {};
			}

			return { cwd, gitBranch, model, modelProvider };
		})();
		headerCache.set(key, promise);
	}

	return promise;
}

export function parseCodexMessageText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(el): el is { type: string; text: string } =>
				!!el &&
				typeof el === "object" &&
				typeof (el as any).type === "string" &&
				typeof (el as any).text === "string" &&
				((el as any).type === "input_text" ||
					(el as any).type === "output_text" ||
					(el as any).type === "text"),
		)
		.map((el) => el.text)
		.join("\n");
}

export function parseCodexToolArguments(
	argumentsText: unknown,
): Record<string, unknown> | undefined {
	if (typeof argumentsText !== "string" || !argumentsText.trim()) return undefined;
	try {
		const parsed = JSON.parse(argumentsText);
		return parsed && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined;
	}
}
