---
name: agent-optic
description: Read AI assistant session data from local provider directories. Use for session history, token costs, daily summaries, tool usage, project activity, or data export.
---

# Session History with agent-optic

agent-optic reads AI assistant session data from local provider directories (`~/.claude`, `~/.codex`, `~/.pi`, `~/.cursor`, `~/.windsurf`).
All data stays local. Zero dependencies. No network access.

Output is structured JSON. Use `--raw` for data-only output. Use `--pretty` for readability. Use `--format jsonl` for streaming large results.

Supported providers: `claude` (default), `codex`, `openai`, `pi`, `cursor`, `windsurf`.

## Core Workflow

Follow the **discover → filter → drill down → aggregate** pattern:

1. **Orient** — run `agent-optic sessions` to see today's sessions
2. **Filter** — narrow by `--date`, `--from`/`--to`, `--project`, or session ID
3. **Drill down** — use `detail <id>` for full parse or `transcript <id>` for the conversation
4. **Aggregate** — use `daily`, `tool-usage`, or `export` for summaries

### Example: "What did I work on this week?"

```bash
# Get this week's daily summary
agent-optic daily --raw --pretty

# Or list all sessions from the past week
agent-optic sessions --from 2026-02-23 --to 2026-02-28 --raw --pretty

# Drill into a specific session
agent-optic detail <session-id> --raw --pretty
```

## Essential Commands

### List Sessions

```bash
# Today's sessions (default)
agent-optic sessions --raw --pretty

# Specific date
agent-optic sessions --date 2026-02-15 --raw --pretty

# Date range
agent-optic sessions --from 2026-02-01 --to 2026-02-28 --raw --pretty

# Filter by project
agent-optic sessions --project my-app --raw --pretty

# Find specific session by ID
agent-optic sessions <session-id> --raw --pretty

# Different provider
agent-optic sessions --provider codex --raw --pretty
agent-optic sessions --provider cursor --raw --pretty
```

### Session Detail

Full parsed session with tool calls, files referenced, and summaries.

```bash
agent-optic detail <session-id> --raw --pretty

# Select specific fields
agent-optic detail <session-id> --raw --fields sessionId,model,totalCost,toolCalls
```

### Transcript

Stream the actual conversation entries from a session.

```bash
# Stream as JSONL (recommended for large sessions)
agent-optic transcript <session-id> --format jsonl --limit 50

# As JSON array
agent-optic transcript <session-id> --raw --pretty --limit 20

# Select fields
agent-optic transcript <session-id> --format jsonl --fields role,content --limit 30
```

### Daily Summary

Aggregated summary for a single day.

```bash
# Today
agent-optic daily --raw --pretty

# Specific date
agent-optic daily --date 2026-02-15 --raw --pretty
```

### Tool Usage

Aggregated tool usage analytics.

```bash
# Today
agent-optic tool-usage --raw --pretty

# Date range
agent-optic tool-usage --from 2026-02-01 --to 2026-02-28 --raw --pretty

# Different provider
agent-optic tool-usage --provider codex --from 2026-02-01 --raw --pretty
```

### Projects

List all known projects across sessions.

```bash
agent-optic projects --raw --pretty
agent-optic projects --provider codex --raw --pretty
```

### Stats

Pre-computed statistics cache (if available).

```bash
agent-optic stats --raw --pretty
```

### Export

Export daily summaries for a date range.

```bash
agent-optic export --from 2026-02-01 --to 2026-02-28 --raw --pretty

# With privacy for sharing
agent-optic export --from 2026-02-01 --to 2026-02-28 --privacy shareable --raw --pretty
```

## Common Patterns

### What did I work on today?

```bash
agent-optic daily --raw --pretty
```

Returns total sessions, prompts, projects, tasks, plans, and todos for today.

### How many sessions this week?

```bash
agent-optic sessions --from 2026-02-23 --to 2026-02-28 --raw --pretty
```

Count the sessions array length, or use `--fields sessionId,projectName` for a quick overview.

### Find a specific session

```bash
# By session ID
agent-optic sessions <session-id> --raw --pretty

# Or search by project and date
agent-optic sessions --project my-app --from 2026-02-01 --raw --pretty
```

### Check token costs

```bash
agent-optic sessions --from 2026-02-01 --raw --fields sessionId,projectName,totalCost,model,totalInputTokens,totalOutputTokens
```

### Which tools am I using most?

```bash
agent-optic tool-usage --from 2026-02-01 --raw --pretty
```

Returns counts by tool name, by category, top files, and top commands.

### Review a session's conversation

```bash
# Preview first 30 entries
agent-optic transcript <session-id> --format jsonl --limit 30

# Full detail for one session
agent-optic detail <session-id> --raw --pretty
```

### Cross-provider comparison

```bash
agent-optic sessions --provider claude --from 2026-02-01 --raw --pretty
agent-optic sessions --provider codex --from 2026-02-01 --raw --pretty
agent-optic sessions --provider cursor --from 2026-02-01 --raw --pretty
```

### Export data for sharing

```bash
# Use shareable privacy to strip paths and sensitive data
agent-optic export --from 2026-02-01 --to 2026-02-28 --privacy shareable --raw --pretty
```

### Project activity

```bash
# Sessions for a specific project
agent-optic sessions --project my-app --from 2026-02-01 --raw --fields sessionId,model,totalCost

# All projects overview
agent-optic projects --raw --pretty
```

## Output Formatting

### JSON Envelope (default)

Every command returns:
```json
{ "schemaVersion": "1.0", "command": "...", "provider": "...", "generatedAt": "...", "data": ... }
```

### Flags

| Flag | Effect |
|------|--------|
| `--raw` | Strip envelope, return `data` only |
| `--pretty` | Pretty-print JSON |
| `--format jsonl` | One JSON object per line (streaming) |
| `--fields a,b,c` | Select top-level fields from objects |
| `--limit N` | Limit array/stream length |

Combine `--raw --pretty` for readable data-only output. Combine `--raw --fields` for minimal output.

## Multi-Provider Support

| Provider | Flag | Data Directory | Notes |
|----------|------|---------------|-------|
| Claude | `--provider claude` | `~/.claude` | Default provider |
| Codex | `--provider codex` | `~/.codex` | OpenAI Codex CLI |
| OpenAI | `--provider openai` | `~/.codex` | Alias for codex format |
| Pi | `--provider pi` | `~/.pi` | No history.jsonl — sessions discovered by directory scan |
| Cursor | `--provider cursor` | `~/.cursor` | Cursor IDE |
| Windsurf | `--provider windsurf` | `~/.windsurf` | Windsurf IDE |

Override the data directory with `--provider-dir <path>` for non-standard installations.

## Privacy

Provider directories contain sensitive data (API keys, source code, personal information).

| Profile | Flag | Behavior |
|---------|------|----------|
| Local | `--privacy local` | Default. Strips tool results and thinking blocks |
| Shareable | `--privacy shareable` | + strips absolute paths, home directory references |
| Strict | `--privacy strict` | + strips prompt text, emails, IPs, credentials |

Always use `--privacy shareable` or `--privacy strict` before sharing output externally.

## Output Schema Reference

### sessions → SessionMeta[]

`sessionId`, `project`, `projectName`, `prompts[]`, `promptTimestamps[]`, `timeRange`, `gitBranch`, `model`, `totalInputTokens`, `totalOutputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`, `messageCount`, `totalCost`

### detail → SessionDetail

Extends SessionMeta with: `assistantSummaries[]`, `toolCalls[]` (each with `name`, `displayName`, `category`, `target`), `filesReferenced[]`, `planReferenced`, `thinkingBlockCount`, `hasSidechains`

### daily → DailySummary

`date`, `sessions[]`, `shortSessions[]`, `tasks[]`, `plans[]`, `todos[]`, `totalPrompts`, `totalSessions`, `projects[]`, `projectMemory`

### tool-usage → ToolUsageReport

`byTool` (map of tool name → count), `byCategory` (map of category → count), `topFiles[]`, `topCommands[]`, `total`

Tool categories: `file_read`, `file_write`, `shell`, `search`, `web`, `task`, `other`

### projects → ProjectInfo[]

`encodedPath`, `decodedPath`, `name`, `sessionCount`, `hasMemory`

### export → DailySummary[]

Array of daily summaries for the requested date range.

## Tips

- Use `--format jsonl` for large result sets to avoid memory issues
- `sessions` defaults to today — use `--from` for historical data
- `detail` parses the full session file and is slower than `sessions`
- `transcript --limit 50` previews without loading everything
- Combine `--raw` with `--fields` for minimal output
- All dates use `YYYY-MM-DD` format in local time
- Session IDs are UUIDs
