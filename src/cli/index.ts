#!/usr/bin/env bun

import { createHistory } from "../agent-optic.js";
import type { PrivacyProfile } from "../types/privacy.js";
import type { Provider } from "../types/provider.js";
import { today } from "../utils/dates.js";
import { defaultProviderDir, isProvider } from "../utils/providers.js";

const HELP = `agent-optic — Read AI assistant session data from local provider directories

USAGE
  agent-optic <command> [options]

COMMANDS
  sessions    List sessions (default: today)
  projects    List all projects
  stats       Show pre-computed stats
  daily       Show daily summary
  export      Export session data with privacy controls

OPTIONS
  --date YYYY-MM-DD     Filter to specific date (default: today)
  --from YYYY-MM-DD     Start of date range
  --to YYYY-MM-DD       End of date range
  --project <name>      Filter by project name
  --provider <name>     Data provider: claude (default), codex, cursor, windsurf
  --provider-dir <path> Override provider data directory (default: ~/.<provider>)
  --privacy <profile>   Privacy profile: local (default), shareable, strict
  --json                Output as JSON (default)
  --help                Show this help

EXAMPLES
  agent-optic sessions
  agent-optic sessions --provider codex --date 2026-02-09
  agent-optic sessions --from 2026-02-01 --to 2026-02-09
  agent-optic daily --date 2026-02-09
  agent-optic projects
  agent-optic stats

SECURITY
  Provider home directories contain highly sensitive data including API keys, source code,
  and personal information. See SECURITY.md for details.
`;

interface CliArgs {
	command: string;
	date?: string;
	from?: string;
	to?: string;
	project?: string;
	provider: Provider;
	providerDir?: string;
	privacy: PrivacyProfile;
	json: boolean;
	help: boolean;
}

function parseArgs(args: string[]): CliArgs {
	const result: CliArgs = {
		command: "",
		provider: "claude",
		privacy: "local",
		json: true,
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
		} else if (arg === "--json") {
			result.json = true;
		} else if (!arg.startsWith("-") && !result.command) {
			result.command = arg;
		}

		i++;
	}

	return result;
}

function output(data: unknown): void {
	console.log(JSON.stringify(data, mapReplacer, 2));
}

/** JSON.stringify replacer that converts Maps to plain objects. */
function mapReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Map) {
		return Object.fromEntries(value);
	}
	return value;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (args.help || !args.command) {
		console.log(HELP);
		process.exit(args.help ? 0 : 1);
	}

	if (!["local", "shareable", "strict"].includes(args.privacy)) {
		console.error(`Invalid privacy profile: ${args.privacy}. Use: local, shareable, strict`);
		process.exit(1);
	}

	if (!isProvider(args.provider)) {
		console.error(
			`Invalid provider: ${args.provider}. Use: claude, codex, cursor, windsurf`,
		);
		process.exit(1);
	}

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
			const sessions = await ch.sessions.listWithMeta(filter);
			output(sessions);
			break;
		}

		case "projects": {
			const projects = await ch.projects.list();
			output(projects);
			break;
		}

		case "stats": {
			const stats = await ch.stats.get();
			if (!stats) {
				console.error(`No stats cache found at ${providerDir}/stats-cache.json`);
				process.exit(1);
			}
			output(stats);
			break;
		}

		case "daily": {
			const date = args.date ?? today();
			const summary = await ch.aggregate.daily(date);
			output(summary);
			break;
		}

		case "export": {
			const date = args.date;
			const from = args.from ?? date ?? today();
			const to = args.to ?? date ?? today();
			const summaries = await ch.aggregate.dailyRange(from, to);
			output(summaries);
			break;
		}

		default:
			console.error(`Unknown command: ${args.command}\n`);
			console.log(HELP);
			process.exit(1);
	}
}

main().catch((err) => {
	console.error("Error:", err.message);
	process.exit(1);
});
