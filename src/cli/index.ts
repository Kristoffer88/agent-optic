#!/usr/bin/env bun

import { createHistory } from "../agent-optic.js";
import type { PrivacyProfile } from "../types/privacy.js";
import type { Provider } from "../types/provider.js";
import { today } from "../utils/dates.js";
import { defaultProviderDir, isProvider } from "../utils/providers.js";

const SCHEMA_VERSION = "1.0";

type OutputFormat = "json" | "jsonl";

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

OPTIONS
  --date YYYY-MM-DD     Filter to specific date (default: today)
  --from YYYY-MM-DD     Start of date range
  --to YYYY-MM-DD       End of date range
  --project <name>      Filter by project name
  --provider <name>     Data provider: claude (default), codex, openai, pi, cursor, windsurf
  --provider-dir <path> Override provider data directory (default: ~/.<provider>)
  --privacy <profile>   Privacy profile: local (default), shareable, strict
  --format <mode>       Output mode: json (default), jsonl
  --fields <a,b,c>      Select object fields (top-level)
  --limit <n>           Limit array/stream length
  --pretty              Pretty-print JSON output
  --raw                 Disable output envelope (data only)
  --help                Show this help

EXAMPLES
  agent-optic sessions --provider codex --format jsonl
  agent-optic detail 019c9aea-484d-7200-87fd-07a545276ac4 --provider openai
  agent-optic transcript 019c9aea-484d-7200-87fd-07a545276ac4 --provider openai --format jsonl --limit 50
  agent-optic tool-usage --provider codex --from 2026-02-01 --to 2026-02-26
  agent-optic sessions --provider codex --date 2026-02-09
  agent-optic sessions --provider openai --date 2026-02-09

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
	project?: string;
	provider: Provider;
	providerDir?: string;
	privacy: PrivacyProfile;
	format: OutputFormat;
	fields?: string[];
	limit?: number;
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

function parseArgs(args: string[]): CliArgs {
	const result: CliArgs = {
		command: "",
		provider: "claude",
		privacy: "local",
		format: "json",
		pretty: false,
		raw: false,
		help: false,
	};

	let i = 0;
	while (i < args.length) {
		const arg = args[i];

		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--date" && args[i + 1]) {
			result.date = args[++i];
		} else if (arg === "--from" && args[i + 1]) {
			result.from = args[++i];
		} else if (arg === "--to" && args[i + 1]) {
			result.to = args[++i];
		} else if (arg === "--project" && args[i + 1]) {
			result.project = args[++i];
		} else if (arg === "--provider" && args[i + 1]) {
			result.provider = args[++i] as Provider;
		} else if (arg === "--provider-dir" && args[i + 1]) {
			result.providerDir = args[++i];
		} else if (arg === "--privacy" && args[i + 1]) {
			result.privacy = args[++i] as PrivacyProfile;
		} else if (arg === "--format" && args[i + 1]) {
			result.format = args[++i] as OutputFormat;
		} else if (arg === "--fields" && args[i + 1]) {
			result.fields = args[++i]
				.split(",")
				.map((f) => f.trim())
				.filter(Boolean);
		} else if (arg === "--limit" && args[i + 1]) {
			const parsed = Number.parseInt(args[++i], 10);
			if (Number.isFinite(parsed) && parsed > 0) {
				result.limit = parsed;
			}
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
	if (Array.isArray(data)) return data.slice(0, limit);
	return data;
}

function writeOutput(
	command: string,
	provider: Provider,
	data: unknown,
	args: CliArgs,
): void {
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
			`Invalid provider: ${args.provider}. Use: claude, codex, openai, pi, cursor, windsurf`,
		);
	}

	if (!["json", "jsonl"].includes(args.format)) {
		throw new CliError(
			"INVALID_FORMAT",
			`Invalid format: ${args.format}. Use: json, jsonl`,
		);
	}
}

async function run(args: CliArgs): Promise<void> {
	if (args.help || !args.command) {
		console.log(HELP);
		process.exit(args.help ? 0 : 1);
	}

	assertValidArgs(args);

	const providerDir = args.providerDir ?? defaultProviderDir(args.provider);
	const ch = createHistory({
		provider: args.provider,
		providerDir,
		privacy: args.privacy,
	});

	const filter = {
		date: args.date,
		from: args.from,
		to: args.to,
		project: args.project,
	};

	switch (args.command) {
		case "sessions": {
			const sessionsFilter =
				args.commandArg && !args.date && !args.from && !args.to
					? { ...filter, from: "2000-01-01", to: "2099-12-31" }
					: filter;
			let sessions = await ch.sessions.listWithMeta(sessionsFilter);
			if (args.commandArg) {
				sessions = sessions.filter((s) => s.sessionId === args.commandArg);
			}
			writeOutput("sessions", args.provider, sessions, args);
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

		default:
			throw new CliError(
				"UNKNOWN_COMMAND",
				`Unknown command: ${args.command}`,
				2,
			);
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	try {
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
