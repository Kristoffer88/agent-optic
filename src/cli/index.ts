#!/usr/bin/env bun

import { createHistory } from "../agent-optic.js";
import type { PrivacyProfile } from "../types/privacy.js";
import type { Provider } from "../types/provider.js";
import { today, toLocalDate } from "../utils/dates.js";
import { defaultProviderDir, isProvider } from "../utils/providers.js";
import { renderPiAgentBoard, type PiAgentBoardSession } from "../boards/pi-agent-board.js";

const SCHEMA_VERSION = "1.0";

type OutputFormat = "json" | "jsonl";
type SessionSort = "recent" | "mtime" | "start" | "end";

const HELP = `agent-optic — Read AI assistant session data from local provider directories

USAGE
  agent-optic <command> [options]

COMMANDS
  sessions <optional-id>   List sessions with metadata
  detail <session-id>      Show full detail for one session
  transcript <session-id>  Stream/print transcript entries
  tool-usage               Show aggregated tool usage
  projects                 List all projects
  stats                    Show pre-computed stats
  daily                    Show daily summary
  export                   Export session data with privacy controls
  pi-board                 Generate a local HTML board for Pi sessions

OPTIONS
  --date YYYY-MM-DD     Filter to specific date (default: today)
  --from YYYY-MM-DD     Start of date range
  --to YYYY-MM-DD       End of date range
  --since <duration>    Rolling window for sessions, e.g. 24h, 90m, 7d
  --project <name|path> Filter by project name or full path
  --provider <name>     Data provider: claude (default), codex, openai, pi, copilot, cursor, claude-desktop, opencode
  --provider-dir <path> Override provider data directory (default: ~/.<provider>)
  --privacy <profile>   Privacy profile: local (default), shareable, strict
  --format <mode>       Output mode: json (default), jsonl
  --fields <a,b,c>      Select object fields (top-level)
  --sort <mode>         Sort sessions: recent (default), mtime, start, end
  --limit <n>           Limit array/stream length
  --pretty              Pretty-print JSON output
  --raw                 Disable output envelope (data only)
  --out <file>          Output file for commands that generate files (pi-board)
  --help                Show this help

EXAMPLES
  agent-optic sessions --provider codex --format jsonl
  agent-optic detail 019c9aea-484d-7200-87fd-07a545276ac4 --provider openai
  agent-optic transcript 019c9aea-484d-7200-87fd-07a545276ac4 --provider openai --format jsonl --limit 50
  agent-optic tool-usage --provider codex --from 2026-02-01 --to 2026-02-26
  agent-optic sessions --provider codex --date 2026-02-09
  agent-optic sessions --provider openai --date 2026-02-09
  agent-optic sessions --provider cursor --date 2026-06-18
  agent-optic sessions --provider claude-desktop --from 2026-06-01
  agent-optic sessions --provider opencode --from 2026-03-01
  agent-optic pi-board --date 2026-06-05 --out ~/work/.pi/agent-board/index.html

SECURITY
  Provider home directories contain highly sensitive data including API keys, source code,
  and personal information. See SECURITY.md for details.
`;

interface CliArgs {
	command: string;
	commandArg?: string;
	date?: string;
	from?: string;
	to?: string;
	since?: string;
	sinceMs?: number;
	project?: string;
	provider: Provider;
	providerDir?: string;
	privacy: PrivacyProfile;
	format: OutputFormat;
	fields?: string[];
	sort: SessionSort;
	limit?: number;
	out?: string;
	pretty: boolean;
	raw: boolean;
	help: boolean;
}

class CliError extends Error {
	constructor(
		public code: string,
		message: string,
		public exitCode = 1,
		public details?: Record<string, unknown>,
	) {
		super(message);
	}
}

const VALUE_OPTIONS = new Set([
	"--date",
	"--from",
	"--to",
	"--since",
	"--project",
	"--provider",
	"--provider-dir",
	"--privacy",
	"--format",
	"--fields",
	"--sort",
	"--limit",
	"--out",
]);

function takeValue(args: string[], i: number, flag: string): string {
	const next = args[i + 1];
	if (next === undefined || VALUE_OPTIONS.has(next) || next === "--pretty" || next === "--raw" || next === "--help" || next === "-h") {
		throw new CliError(
			"MISSING_OPTION_VALUE",
			`Missing value for ${flag}`,
			2,
			{ option: flag },
		);
	}
	return next;
}

function parseSinceDuration(raw: string): number {
	const match = raw.trim().match(/^(\d+)(m|h|d|w)$/i);
	if (!match) {
		throw new CliError(
			"INVALID_SINCE",
			`Invalid --since value: ${raw}. Use a duration like 90m, 24h, 7d, or 2w.`,
			2,
			{ value: raw },
		);
	}
	const value = Number.parseInt(match[1], 10);
	const unit = match[2].toLowerCase();
	const multipliers: Record<string, number> = {
		m: 60_000,
		h: 60 * 60_000,
		d: 24 * 60 * 60_000,
		w: 7 * 24 * 60 * 60_000,
	};
	return value * multipliers[unit];
}

function parseArgs(args: string[]): CliArgs {
	const result: CliArgs = {
		command: "",
		provider: "claude",
		privacy: "local",
		format: "json",
		sort: "recent",
		pretty: false,
		raw: false,
		help: false,
	};

	let i = 0;
	while (i < args.length) {
		const arg = args[i];

		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--date") {
			result.date = takeValue(args, i++, arg);
		} else if (arg === "--from") {
			result.from = takeValue(args, i++, arg);
		} else if (arg === "--to") {
			result.to = takeValue(args, i++, arg);
		} else if (arg === "--since") {
			result.since = takeValue(args, i++, arg);
			result.sinceMs = parseSinceDuration(result.since);
		} else if (arg === "--project") {
			result.project = takeValue(args, i++, arg);
		} else if (arg === "--provider") {
			result.provider = takeValue(args, i++, arg) as Provider;
		} else if (arg === "--provider-dir") {
			result.providerDir = takeValue(args, i++, arg);
		} else if (arg === "--privacy") {
			result.privacy = takeValue(args, i++, arg) as PrivacyProfile;
		} else if (arg === "--format") {
			result.format = takeValue(args, i++, arg) as OutputFormat;
		} else if (arg === "--fields") {
			result.fields = takeValue(args, i++, arg)
				.split(",")
				.map((f) => f.trim())
				.filter(Boolean);
		} else if (arg === "--sort") {
			result.sort = takeValue(args, i++, arg) as SessionSort;
		} else if (arg === "--limit") {
			const raw = takeValue(args, i++, arg);
			const parsed = Number.parseInt(raw, 10);
			if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
				throw new CliError(
					"INVALID_LIMIT",
					`Invalid --limit value: ${raw}. Must be a positive integer.`,
					2,
					{ value: raw },
				);
			}
			result.limit = parsed;
		} else if (arg === "--out") {
			result.out = takeValue(args, i++, arg);
		} else if (arg === "--pretty") {
			result.pretty = true;
		} else if (arg === "--raw") {
			result.raw = true;
		} else if (!arg.startsWith("-") && !result.command) {
			result.command = arg;
		} else if (!arg.startsWith("-") && !result.commandArg) {
			result.commandArg = arg;
		}

		i++;
	}

	return result;
}

const KNOWN_TOP_LEVEL_FIELDS: Record<string, string[]> = {
	sessions: [
		"sessionId",
		"project",
		"projectName",
		"prompts",
		"promptTimestamps",
		"timeRange",
		"lastFileActivity",
		"lastPrompt",
		"lastPromptTimestamp",
		"userPromptCount",
		"activityKind",
		"dataCompleteness",
		"sourceCapabilities",
		"gitBranch",
		"model",
		"totalInputTokens",
		"totalOutputTokens",
		"cacheCreationInputTokens",
		"cacheReadInputTokens",
		"messageCount",
		"totalCost",
	],
	detail: [
		"sessionId",
		"project",
		"projectName",
		"prompts",
		"promptTimestamps",
		"timeRange",
		"lastFileActivity",
		"lastPrompt",
		"lastPromptTimestamp",
		"userPromptCount",
		"activityKind",
		"dataCompleteness",
		"sourceCapabilities",
		"gitBranch",
		"model",
		"totalInputTokens",
		"totalOutputTokens",
		"cacheCreationInputTokens",
		"cacheReadInputTokens",
		"messageCount",
		"totalCost",
		"assistantSummaries",
		"toolCalls",
		"filesReferenced",
		"planReferenced",
		"thinkingBlockCount",
		"hasSidechains",
	],
	transcript: [
		"type",
		"subtype",
		"message",
		"timestamp",
		"gitBranch",
		"planContent",
		"cwd",
		"sessionId",
		"isSidechain",
		"parentUuid",
		"uuid",
		"toolUseResult",
		"isMeta",
		"durationMs",
		"error",
		"isApiErrorMessage",
		"version",
		"slug",
		"agentId",
		"userType",
	],
	"pi-board": ["path", "sessions"],
};

function availableTopLevelFields(command: string, data: unknown): Set<string> {
	const fields = new Set<string>(KNOWN_TOP_LEVEL_FIELDS[command] ?? []);
	const rows = Array.isArray(data) ? data : [data];
	for (const row of rows) {
		if (!row || typeof row !== "object") continue;
		for (const key of Object.keys(row as Record<string, unknown>)) fields.add(key);
	}
	return fields;
}

function assertKnownFields(command: string, data: unknown, fields?: string[]): void {
	if (!fields || fields.length === 0) return;
	const available = availableTopLevelFields(command, data);
	if (available.size === 0) return;
	const unknown = fields.filter((field) => !available.has(field));
	if (unknown.length === 0) return;
	throw new CliError(
		"UNKNOWN_FIELDS",
		`Unknown --fields value(s): ${unknown.join(", ")}. Valid top-level fields include: ${[...available].sort().join(", ")}`,
		2,
		{ fields: unknown, availableFields: [...available].sort() },
	);
}

function applyFieldSelection(data: unknown, fields?: string[]): unknown {
	if (!fields || fields.length === 0) return data;

	if (Array.isArray(data)) {
		return data.map((item) => applyFieldSelection(item, fields));
	}

	if (!data || typeof data !== "object") return data;
	const obj = data as Record<string, unknown>;
	const selected: Record<string, unknown> = {};
	for (const field of fields) {
		if (field in obj) selected[field] = obj[field];
	}
	return selected;
}

function applyLimit(data: unknown, limit?: number): unknown {
	if (!limit) return data;
	if (Array.isArray(data)) {
		return data.slice(0, limit).map((item) => applyLimit(item, limit));
	}
	if (data instanceof Map) {
		return new Map(
			[...data.entries()].map(([key, value]) => [key, applyLimit(value, limit)]),
		);
	}
	if (!data || typeof data !== "object") return data;
	return Object.fromEntries(
		Object.entries(data as Record<string, unknown>).map(([key, value]) => [
			key,
			applyLimit(value, limit),
		]),
	);
}

function sessionSortValue(session: Record<string, any>, sort: SessionSort): number {
	const start = Number(session.timeRange?.start ?? 0);
	const end = Number(session.timeRange?.end ?? 0);
	const mtime = Number(session.lastFileActivity ?? 0);
	if (sort === "mtime") return mtime || end || start;
	if (sort === "start") return start;
	if (sort === "end") return end || start;
	return Math.max(mtime, end, start);
}

function sortSessions<T extends Record<string, any>>(sessions: T[], sort: SessionSort): T[] {
	return [...sessions].sort((a, b) => {
		const diff = sessionSortValue(b, sort) - sessionSortValue(a, sort);
		if (diff !== 0) return diff;
		return String(a.sessionId ?? "").localeCompare(String(b.sessionId ?? ""));
	});
}

function applySinceFilter<T extends Record<string, any>>(sessions: T[], cutoffMs?: number): T[] {
	if (!cutoffMs) return sessions;
	return sessions.filter((session) => sessionSortValue(session, "recent") >= cutoffMs);
}

function writeOutput(
	command: string,
	provider: Provider,
	data: unknown,
	args: CliArgs,
): void {
	assertKnownFields(command, data, args.fields);
	const transformed = applyLimit(applyFieldSelection(data, args.fields), args.limit);
	const generatedAt = new Date().toISOString();

	if (args.format === "json") {
		const payload = args.raw
			? transformed
			: {
				schemaVersion: SCHEMA_VERSION,
				command,
				provider,
				generatedAt,
				data: transformed,
			};
		console.log(
			JSON.stringify(payload, mapReplacer, args.pretty ? 2 : 0),
		);
		return;
	}

	const rows = Array.isArray(transformed) ? transformed : [transformed];
	for (const row of rows) {
		const payload = args.raw
			? row
			: {
				schemaVersion: SCHEMA_VERSION,
				command,
				provider,
				generatedAt,
				data: row,
			};
		console.log(JSON.stringify(payload, mapReplacer));
	}
}

/** JSON.stringify replacer that converts Maps to plain objects. */
function mapReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Map) {
		return Object.fromEntries(value);
	}
	return value;
}

function printError(error: CliError, args?: CliArgs): void {
	const format = args?.format ?? "json";
	const payload = {
		schemaVersion: SCHEMA_VERSION,
		error: {
			code: error.code,
			message: error.message,
			details: error.details,
		},
	};
	const text =
		format === "json" && args?.pretty
			? JSON.stringify(payload, null, 2)
			: JSON.stringify(payload);
	console.error(text);
}

function assertValidArgs(args: CliArgs): void {
	if (!["local", "shareable", "strict"].includes(args.privacy)) {
		throw new CliError(
			"INVALID_PRIVACY_PROFILE",
			`Invalid privacy profile: ${args.privacy}. Use: local, shareable, strict`,
		);
	}

	if (!isProvider(args.provider)) {
		throw new CliError(
			"INVALID_PROVIDER",
		`Invalid provider: ${args.provider}. Use: claude, codex, openai, pi, copilot, cursor, claude-desktop, opencode`,
		);
	}

	if (!["json", "jsonl"].includes(args.format)) {
		throw new CliError(
			"INVALID_FORMAT",
			`Invalid format: ${args.format}. Use: json, jsonl`,
		);
	}

	if (args.since && (args.date || args.from || args.to)) {
		throw new CliError(
			"CONFLICTING_DATE_FILTERS",
			"Use --since by itself, or use --date/--from/--to. Do not combine them.",
			2,
		);
	}

	if (!["recent", "mtime", "start", "end"].includes(args.sort)) {
		throw new CliError(
			"INVALID_SORT",
			`Invalid sort: ${args.sort}. Use: recent, mtime, start, end`,
			2,
		);
	}
}

async function run(args: CliArgs): Promise<void> {
	if (args.help || !args.command) {
		console.log(HELP);
		process.exit(args.help ? 0 : 1);
	}

	if (args.command === "pi-board") args.provider = "pi";

	assertValidArgs(args);

	const providerDir = args.providerDir ?? defaultProviderDir(args.provider);
	const ch = createHistory({
		provider: args.provider,
		providerDir,
		privacy: args.privacy,
	});

	const sinceCutoffMs = args.sinceMs ? Date.now() - args.sinceMs : undefined;
	const filter = {
		date: args.date,
		from: args.from ?? (sinceCutoffMs ? toLocalDate(sinceCutoffMs) : undefined),
		to: args.to,
		project: args.project,
	};

	switch (args.command) {
		case "sessions": {
			const sessionsFilter =
				args.commandArg && !args.date && !args.from && !args.to && !args.since
					? { ...filter, from: "2000-01-01", to: "2099-12-31" }
					: filter;
			let sessions = await ch.sessions.listWithMeta(sessionsFilter);
			sessions = applySinceFilter(sessions, sinceCutoffMs);
			if (args.commandArg) {
				sessions = sessions.filter((s) => s.sessionId === args.commandArg);
			}
			writeOutput("sessions", args.provider, sortSessions(sessions, args.sort), args);
			return;
		}

		case "detail": {
			if (!args.commandArg) {
				throw new CliError(
					"MISSING_ARGUMENT",
					"Missing session ID. Usage: agent-optic detail <session-id>",
				);
			}
			const detail = await ch.sessions.detail(args.commandArg, args.project);
			writeOutput("detail", args.provider, detail, args);
			return;
		}

		case "transcript": {
			if (!args.commandArg) {
				throw new CliError(
					"MISSING_ARGUMENT",
					"Missing session ID. Usage: agent-optic transcript <session-id>",
				);
			}

			if (args.format === "jsonl") {
				assertKnownFields("transcript", undefined, args.fields);
				const generatedAt = new Date().toISOString();
				let count = 0;
				for await (const entry of ch.sessions.transcript(args.commandArg, args.project)) {
					if (args.limit && count >= args.limit) break;
					const transformed = applyFieldSelection(entry, args.fields);
					const payload = args.raw
						? transformed
						: {
							schemaVersion: SCHEMA_VERSION,
							command: "transcript",
							provider: args.provider,
							generatedAt,
							data: transformed,
						};
					console.log(JSON.stringify(payload, mapReplacer));
					count++;
				}
				return;
			}

			const entries: unknown[] = [];
			for await (const entry of ch.sessions.transcript(args.commandArg, args.project)) {
				entries.push(entry);
				if (args.limit && entries.length >= args.limit) break;
			}
			writeOutput("transcript", args.provider, entries, args);
			return;
		}

		case "tool-usage": {
			const usage = await ch.aggregate.toolUsage(filter);
			writeOutput("tool-usage", args.provider, usage, args);
			return;
		}

		case "projects": {
			const projects = await ch.projects.list();
			writeOutput("projects", args.provider, projects, args);
			return;
		}

		case "stats": {
			const stats = await ch.stats.get();
			if (!stats) {
				throw new CliError(
					"STATS_NOT_FOUND",
					`No stats cache found at ${providerDir}/stats-cache.json`,
				);
			}
			writeOutput("stats", args.provider, stats, args);
			return;
		}

		case "daily": {
			const date = args.date ?? today();
			const summary = await ch.aggregate.daily(date);
			writeOutput("daily", args.provider, summary, args);
			return;
		}

		case "export": {
			const date = args.date;
			const from = args.from ?? date ?? today();
			const to = args.to ?? date ?? today();
			const summaries = await ch.aggregate.dailyRange(from, to);
			writeOutput("export", args.provider, summaries, args);
			return;
		}

		case "pi-board": {
			const out = args.out;
			if (!out) {
				throw new CliError(
					"MISSING_OPTION_VALUE",
					"Missing --out <file>. Usage: agent-optic pi-board --out ~/work/.pi/agent-board/index.html",
					2,
				);
			}
			const sessions = (await ch.sessions.listWithMeta(filter)).sort((a, b) => (b.timeRange.end ?? 0) - (a.timeRange.end ?? 0));
			const limited = sessions.slice(0, args.limit ?? 50);
			const boardSessions: PiAgentBoardSession[] = [];
			for (const session of limited) {
				try {
					const detail = await ch.sessions.detail(session.sessionId, session.project);
					boardSessions.push({ ...session, detail });
				} catch {
					boardSessions.push(session);
				}
			}
			const html = renderPiAgentBoard(boardSessions, {
				from: args.from ?? args.date,
				to: args.to ?? args.date,
			});
			await Bun.write(out, html);
			writeOutput("pi-board", args.provider, { path: out, sessions: boardSessions.length }, args);
			return;
		}

		default:
			throw new CliError(
				"UNKNOWN_COMMAND",
				`Unknown command: ${args.command}`,
				2,
			);
	}
}

async function main() {
	let args: CliArgs | undefined;
	try {
		args = parseArgs(process.argv.slice(2));
		await run(args);
	} catch (err) {
		if (err instanceof CliError) {
			printError(err, args);
			process.exit(err.exitCode);
		}
		const fallback = new CliError(
			"INTERNAL_ERROR",
			err instanceof Error ? err.message : "Unknown error",
		);
		printError(fallback, args);
		process.exit(fallback.exitCode);
	}
}

main();
