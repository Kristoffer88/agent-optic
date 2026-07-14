---
name: query-history
description: Query Claude Code session history directly from ~/.claude/ using bash and jq. Use for reading past prompts, session transcripts, token usage, tool calls, stats, plans, and project memory — no CLI tool required.
---

# Query Claude History with bash + jq

All Claude Code data lives in `~/.claude/`. Everything is plain JSON or JSONL — readable with `jq`, `grep`, and `cat`.

## File layout

```
~/.claude/
  history.jsonl                          # every prompt ever typed (fast index)
  stats-cache.json                       # precomputed totals and daily activity
  projects/{encoded-path}/*.jsonl        # full session transcripts
  projects/{encoded-path}/memory/        # MEMORY.md files
  plans/*.md                             # plan files
  todos/*.json                           # todo lists
```

Project paths are encoded with `/` replaced by `-`, so a project named `my-app` becomes `-my-app`.

---

## Recent prompts

```bash
# Last 20 prompts
tail -20 ~/.claude/history.jsonl | jq -r '.display'

# Last 50, with project name
tail -50 ~/.claude/history.jsonl | jq -r '[.project | split("/") | last, .display] | @tsv'

# Today's prompts
jq -r 'select((.timestamp / 1000 | strftime("%Y-%m-%d")) == (now | strftime("%Y-%m-%d"))) | .display' \
  ~/.claude/history.jsonl

# Specific date
jq -r 'select(.timestamp / 1000 | strftime("%Y-%m-%d") == "2026-03-20") | .display' \
  ~/.claude/history.jsonl
```

---

## Search prompts

```bash
# Search by keyword
grep -i "refactor" ~/.claude/history.jsonl | jq -r '.display'

# Search within a project
jq -r 'select(.project | contains("my-app")) | .display' ~/.claude/history.jsonl

# Search by keyword + show project
grep -i "database" ~/.claude/history.jsonl | jq -r '[.project | split("/") | last, .display] | @tsv'
```

---

## Find sessions for a project

```bash
# List all project directories
ls ~/.claude/projects/

# Find a project by name
ls ~/.claude/projects/ | grep -i "my-app"

# List session files for a project
ls ~/.claude/projects/-Users-you-repos-my-app/*.jsonl

# Count sessions per project
for d in ~/.claude/projects/*/; do
  count=$(ls "$d"*.jsonl 2>/dev/null | wc -l)
  echo "$count  $(basename "$d")"
done | sort -rn | head -20
```

---

## Read a session transcript

```bash
PROJ="-Users-you-repos-my-app"
SESSION="abc123-def4-..."   # UUID from history.jsonl or ls output

# All user prompts in a session (string content only — skips tool results)
jq -r 'select(.type == "user") | select(.message.content | type == "string") | .message.content' \
  ~/.claude/projects/$PROJ/$SESSION.jsonl

# All assistant text responses
jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text' \
  ~/.claude/projects/$PROJ/$SESSION.jsonl

# Conversation view: role + content (strings only)
jq -r 'select(.message.role) |
  select(.message.content | type == "string") |
  .message.role + ": " + .message.content' \
  ~/.claude/projects/$PROJ/$SESSION.jsonl
```

---

## Tool calls

```bash
# All tool calls in a session (name + primary input)
jq -r 'select(.type == "assistant") |
  .message.content[]? |
  select(.type == "tool_use") |
  .name + "\t" + (.input.command? // .input.file_path? // .input.pattern? // "")' \
  ~/.claude/projects/$PROJ/$SESSION.jsonl

# Count tool calls by name
jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | .name' \
  ~/.claude/projects/$PROJ/$SESSION.jsonl | sort | uniq -c | sort -rn

# Bash commands run in a session
jq -r 'select(.type == "assistant") |
  .message.content[]? |
  select(.type == "tool_use") |
  select(.name == "Bash") |
  .input.command' \
  ~/.claude/projects/$PROJ/$SESSION.jsonl

# Files read or written
jq -r 'select(.type == "assistant") |
  .message.content[]? |
  select(.type == "tool_use") |
  select(.name | test("Read|Write|Edit")) |
  [.name, .input.file_path?] | @tsv' \
  ~/.claude/projects/$PROJ/$SESSION.jsonl
```

---

## Token usage

```bash
# Total tokens for a session
jq -s '[.[] | select(.type == "assistant") | .message.usage // empty] | {
  input:       map(.input_tokens                // 0) | add,
  output:      map(.output_tokens               // 0) | add,
  cache_read:  map(.cache_read_input_tokens     // 0) | add,
  cache_write: map(.cache_creation_input_tokens // 0) | add
}' ~/.claude/projects/$PROJ/$SESSION.jsonl

# Model used in session
jq -r 'select(.type == "assistant") | .message.model' \
  ~/.claude/projects/$PROJ/$SESSION.jsonl | sort -u
```

---

## Stats cache

The `stats-cache.json` file has precomputed aggregates — no need to scan all sessions.

```bash
# Quick overview
jq '{totalSessions, totalMessages, lastComputedDate}' ~/.claude/stats-cache.json

# Daily activity (last 14 days)
jq '.dailyActivity | sort_by(.date) | .[-14:] | .[]' ~/.claude/stats-cache.json

# Busiest day
jq '.dailyActivity | max_by(.messageCount)' ~/.claude/stats-cache.json

# Model token breakdown
jq '.modelUsage | to_entries | map({
  model: .key,
  input:  .value.inputTokens,
  output: .value.outputTokens,
  cache_read: .value.cacheReadInputTokens
}) | sort_by(.output) | reverse' ~/.claude/stats-cache.json

# Hour of day distribution (when do you work?)
jq '.hourCounts | to_entries | sort_by(.key | tonumber) | map(.key + ":00  " + (.value | tostring))[]' \
  ~/.claude/stats-cache.json

# Longest session
jq '.longestSession' ~/.claude/stats-cache.json
```

---

## Plans

```bash
# List all plan files
ls ~/.claude/plans/

# Read a plan
cat ~/.claude/plans/some-plan-slug.md

# Search plans for a keyword
grep -ril "auth" ~/.claude/plans/
```

---

## Todos

```bash
# List all todo files
ls ~/.claude/todos/

# Show all pending todos across all sessions
cat ~/.claude/todos/*.json | jq -r '.[] | select(.status != "completed") | .content // .subject'
```

---

## Project memory

```bash
# Find all MEMORY.md files
find ~/.claude/projects -name "MEMORY.md"

# Read memory for a specific project
cat ~/.claude/projects/-Users-you-repos-my-app/memory/MEMORY.md

# Search across all project memories
grep -ril "authentication" ~/.claude/projects/*/memory/
```

---

## Common recipes

### What did I work on today?

```bash
jq -r 'select((.timestamp / 1000 | strftime("%Y-%m-%d")) == (now | strftime("%Y-%m-%d"))) |
  [(.project | split("/") | last), .display] | @tsv' \
  ~/.claude/history.jsonl
```

### Which projects have I used most this week?

```bash
WEEK_AGO=$(( $(date +%s) * 1000 - 7 * 86400000 ))
jq -r --argjson w "$WEEK_AGO" \
  'select(.timestamp > $w) | .project | split("/") | last' \
  ~/.claude/history.jsonl | sort | uniq -c | sort -rn
```

### Find the session where I worked on X

```bash
# Search history index first (fast)
grep -i "keyword" ~/.claude/history.jsonl | jq -r '[.sessionId, .project, .display] | @tsv'

# Then read that session's transcript
jq -r 'select(.message.content | type == "string") | .message.role + ": " + .message.content' \
  ~/.claude/projects/$PROJ/$SESSION.jsonl | less
```

### How many prompts per day this month?

```bash
MONTH=$(date +%Y-%m)
jq -r --arg m "$MONTH" \
  'select(.timestamp / 1000 | strftime("%Y-%m") == $m) | .timestamp / 1000 | strftime("%Y-%m-%d")' \
  ~/.claude/history.jsonl | sort | uniq -c | sort -k2
```

### Which session had the most tool calls?

```bash
for f in ~/.claude/projects/$PROJ/*.jsonl; do
  count=$(jq '[select(.type=="assistant") | .message.content[]? | select(.type=="tool_use")] | length' "$f" 2>/dev/null | paste -sd+ | bc)
  echo "$count  $(basename "$f")"
done | sort -rn | head -10
```

---

## Tips

- `history.jsonl` is the fastest way to find sessions — it's a small index file
- Session `.jsonl` files can be large; pipe through `head` or use `jq` streaming (`--stream`) for huge files
- Timestamps in `history.jsonl` are **milliseconds** — divide by 1000 for `strftime`
- Timestamps in session `.jsonl` files are **ISO strings** (e.g. `"2026-03-18T20:11:49.545Z"`)
- `jq -r` strips quotes from string output; omit `-r` to keep JSON
- Tool result messages are `type == "user"` with array content — filter them out with `select(.message.content | type == "string")`
