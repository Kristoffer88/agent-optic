---
name: agent-optic
description: Read AI assistant session data from local provider directories. Use for session history, token costs, daily summaries, tool usage, project activity, or data export.
---

# agent-optic

Read AI assistant session data from local provider directories (`~/.claude`, `~/.codex`, `~/.pi`, `~/.cursor`, `~/.windsurf`). All data stays local. Zero dependencies. No network access.

Output is structured JSON. Always use `--raw --pretty` for readable data-only output.

Providers: `claude` (default), `codex`, `openai`, `pi`, `cursor`, `windsurf`. Set with `--provider <name>`.

**Performance tiers** — pick the right command for the job:
- `sessions` — fast (reads index only). Use for listing, filtering, cost queries.
- `detail <id>` — slow (parses full session file). Use for single-session deep dives.
- `transcript <id>` — streaming. Use `--format jsonl --limit N` to preview.

## Commands

| Command | Output | Speed |
|---------|--------|-------|
| `sessions [id?]` | Session list with metadata | Fast |
| `detail <id>` | Full parsed session | Slow |
| `transcript <id>` | Conversation entries | Stream |
| `daily` | Single-day summary | Medium |
| `tool-usage` | Aggregated tool analytics | Medium |
| `projects` | All known projects | Fast |
| `stats` | Pre-computed stats cache | Fast |
| `export` | Daily summaries for date range | Slow |

**Filtering**: `--date YYYY-MM-DD`, `--from YYYY-MM-DD`, `--to YYYY-MM-DD`, `--project <name>`
**Output shaping**: `--raw`, `--pretty`, `--fields a,b,c`, `--limit N`, `--format jsonl`

## Use Cases

### "What did I work on today?"

```bash
agent-optic daily --raw --pretty
```

Returns a single-day `DailySummary` with: `sessions[]` (3+ prompts, fully parsed), `shortSessions[]` (1-2 prompts), `tasks[]`, `plans[]`, `todos[]`, `totalPrompts`, `totalSessions`, `projects[]`.

Present as a bulleted list of projects worked on. Use each session's first prompt (`prompts[0]`) as a description of what was done. Include `tasks` and `todos` if present.

For a specific date: `agent-optic daily --date 2026-02-15 --raw --pretty`

### "What did I work on this week?"

The `daily` command returns only a single day. For multi-day summaries, use `export`:

```bash
agent-optic export --from 2026-02-24 --to 2026-02-28 --raw --pretty
```

Returns `DailySummary[]` — one entry per day. Summarize across days: list projects, total sessions, total prompts, notable tasks and plans.

### "How much has AI cost me?"

```bash
agent-optic sessions --from 2026-02-01 --to 2026-02-28 --raw --pretty
```

Each session has a pre-calculated `totalCost` field (USD). Sum across sessions for the total. Group by `model` for per-model breakdown. Group by `projectName` for per-project costs.

For a quick cost overview with minimal output:

```bash
agent-optic sessions --from 2026-02-01 --raw --fields sessionId,projectName,model,totalCost
```

Token breakdown fields: `totalInputTokens`, `totalOutputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`.

### "Generate a timesheet"

```bash
agent-optic sessions --from 2026-02-24 --to 2026-02-28 --raw --pretty
```

Derive working hours from each session's `timeRange`:
- Duration per session: `(timeRange.end - timeRange.start)` milliseconds
- Group sessions by date (from `timeRange.start`) and `projectName`
- Sum durations per group, convert to hours
- Cap gaps between consecutive prompts at 15 minutes to avoid inflating idle time

Present as a table:

```
Day   | Date       | Project        | Hours | Sessions | Prompts
Mon   | 2026-02-24 | my-app         |   2.3 |        3 |      28
Mon   | 2026-02-24 | docs           |   0.5 |        1 |       4
Tue   | 2026-02-25 | my-app         |   3.1 |        2 |      35
```

### "Cost per feature / branch"

```bash
agent-optic sessions --from 2026-02-01 --raw --pretty
```

Group sessions by `gitBranch` field. Sum `totalCost` per branch. Present as:

```
Branch                    | Sessions | Cost    | Tokens
feat/auth                 |        5 | $1.23   | 245K
fix/parsing-bug           |        2 | $0.45   | 89K
refactor/db-layer         |        8 | $3.67   | 712K
```

Sessions without a branch appear as `(no branch)`.

### "What tools am I using most?"

```bash
agent-optic tool-usage --from 2026-02-01 --raw --pretty
```

Returns a `ToolUsageReport` with:
- `byTool`: map of tool name to count (e.g. `{ "Read": 145, "Bash": 89, "Write": 32 }`)
- `byCategory`: map of category to count (`file_read`, `file_write`, `shell`, `search`, `web`, `task`, `other`)
- `topFiles[]`: most accessed files with counts
- `topCommands[]`: most run shell commands with counts
- `total`: total tool invocations

Present as a ranked list with percentages. Highlight the top 5 tools and most-touched files.

### "Show me what happened in session X"

For an overview:

```bash
agent-optic detail <session-id> --raw --pretty
```

Returns `SessionDetail` with: `assistantSummaries[]` (first 200 chars of top assistant responses), `toolCalls[]` (each with `name`, `category`, `target`), `filesReferenced[]`, `thinkingBlockCount`, `hasSidechains`.

For the actual conversation:

```bash
agent-optic transcript <session-id> --format jsonl --limit 50
```

Each line is a transcript entry. Fields are nested: user prompts are at `message.role` and `message.content`, not top-level. To select specific fields use: `--fields message,timestamp`

### "Which projects have I worked on?"

```bash
agent-optic projects --raw --pretty
```

Returns `ProjectInfo[]` with: `name`, `sessionCount`, `hasMemory`, `encodedPath`, `decodedPath`.

Drill into a specific project:

```bash
agent-optic sessions --project my-app --from 2026-02-01 --raw --pretty
```

### "What are my work patterns?"

```bash
agent-optic sessions --from 2026-02-01 --raw --pretty
```

Derive patterns from `timeRange.start` (Unix ms timestamp):
- **Peak hours**: group by `new Date(timeRange.start).getHours()`, find the mode
- **Late nights**: sessions where hour is 22-4
- **Weekends**: sessions where `new Date(timeRange.start).getDay()` is 0 (Sun) or 6 (Sat)
- **Busiest day**: group by date, find the max
- **Longest sessions**: sort by `timeRange.end - timeRange.start`
- **Most expensive**: sort by `totalCost`

If pre-computed stats are available, use `agent-optic stats --raw --pretty` which has `hourCounts` already calculated.

### "Compare usage across providers"

Run for each provider separately:

```bash
agent-optic sessions --provider claude --from 2026-02-01 --raw --fields sessionId,projectName,totalCost
agent-optic sessions --provider codex --from 2026-02-01 --raw --fields sessionId,projectName,totalCost
agent-optic sessions --provider cursor --from 2026-02-01 --raw --fields sessionId,projectName,totalCost
```

Compare: session counts, total cost, token volumes across providers.

### "Export data for sharing"

```bash
agent-optic export --from 2026-02-01 --to 2026-02-28 --privacy shareable --raw --pretty
```

Privacy profiles control what gets redacted:

| Profile | Flag | What it redacts |
|---------|------|-----------------|
| Local | `--privacy local` | Tool results and thinking blocks (default) |
| Shareable | `--privacy shareable` | + absolute paths and home directory references |
| Strict | `--privacy strict` | + prompt text, emails, IPs, credentials |

`shareable` only redacts paths — it does not strip prompt text, emails, or credentials. Use `strict` when sharing publicly or with external parties who should not see prompt content.

## Key Fields Reference

### SessionMeta (from `sessions`)

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | string | UUID |
| `projectName` | string | Decoded project path |
| `prompts[]` | string[] | All user prompts |
| `promptTimestamps[]` | number[] | Unix ms per prompt |
| `timeRange` | `{ start, end }` | Unix ms |
| `gitBranch` | string? | Git branch during session |
| `model` | string? | Model used (e.g. `claude-opus-4-6`) |
| `totalCost` | number? | Pre-calculated USD cost |
| `totalInputTokens` | number | Input tokens |
| `totalOutputTokens` | number | Output tokens |
| `cacheCreationInputTokens` | number | Cache write tokens |
| `cacheReadInputTokens` | number | Cache read tokens |
| `messageCount` | number | Total messages |

### SessionDetail (from `detail`) — extends SessionMeta

| Field | Type | Description |
|-------|------|-------------|
| `assistantSummaries[]` | string[] | First 200 chars of top 10 responses |
| `toolCalls[]` | ToolCallSummary[] | All tool invocations |
| `filesReferenced[]` | string[] | All file paths mentioned |
| `thinkingBlockCount` | number | Extended thinking blocks |
| `hasSidechains` | boolean | Concurrent sessions detected |

Each `toolCalls[]` entry has: `name`, `displayName`, `category` (`file_read` | `file_write` | `shell` | `search` | `web` | `task` | `other`), `target` (file path or command).

### DailySummary (from `daily` / `export`)

| Field | Type | Description |
|-------|------|-------------|
| `date` | string | YYYY-MM-DD |
| `sessions[]` | SessionDetail[] | Sessions with 3+ prompts |
| `shortSessions[]` | SessionInfo[] | Sessions with 1-2 prompts |
| `tasks[]` | TaskInfo[] | Tasks created/updated |
| `plans[]` | PlanInfo[] | Plans created/updated |
| `todos[]` | TodoItem[] | Todos created/updated |
| `totalPrompts` | number | Sum across all sessions |
| `totalSessions` | number | Total session count |
| `projects[]` | string[] | Unique project names |

### ToolUsageReport (from `tool-usage`)

| Field | Type | Description |
|-------|------|-------------|
| `byTool` | map | Tool name to invocation count |
| `byCategory` | map | Category to invocation count |
| `topFiles[]` | array | `{ path, count }` — top 20 files |
| `topCommands[]` | array | `{ command, count }` — top 20 commands |
| `total` | number | Total tool invocations |

## Multi-Provider Support

| Provider | Flag | Directory | Notes |
|----------|------|-----------|-------|
| Claude | `--provider claude` | `~/.claude` | Default |
| Codex | `--provider codex` | `~/.codex` | OpenAI Codex CLI |
| OpenAI | `--provider openai` | `~/.codex` | Alias for codex |
| Pi | `--provider pi` | `~/.pi` | No history.jsonl — directory scan |
| Cursor | `--provider cursor` | `~/.cursor` | Cursor IDE |
| Windsurf | `--provider windsurf` | `~/.windsurf` | Windsurf IDE |

Override data directory: `--provider-dir <path>`

## Tips

- `sessions` defaults to today — add `--from` for historical data
- `daily` returns a single day only — use `export --from --to` for date ranges
- All dates are `YYYY-MM-DD` in local time. Session IDs are UUIDs.
- Use `--format jsonl` for large result sets to avoid memory issues
- Use `--fields` to reduce output: `--fields sessionId,projectName,totalCost`
- `transcript --limit 50` previews a session without loading everything
- `detail` is significantly slower than `sessions` — only use for single sessions
- Transcript fields are nested under `message` (e.g. `message.role`, `message.content`)
