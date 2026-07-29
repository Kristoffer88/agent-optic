---
name: agent-optic
description: Inspect local AI-assistant sessions, transcripts, token usage, tool activity, projects, and exports with the agent-optic CLI.
---

# Agent Optic

Use `agent-optic` for structured, local-only access to assistant history. It supports `claude`, `codex`/`openai`, `pi`, `copilot`, `cursor`, `claude-desktop`, and `opencode`.

## Workflow

1. **Orient:** start with `sessions` for one provider or `observe` for a bounded cross-provider snapshot.
2. **Narrow:** filter by session ID, project, date range, or rolling `--since` window.
3. **Retrieve evidence:** use `evidence` for bounded term-based excerpts before loading a transcript.
4. **Drill down:** use `detail` for parsed session facts and `transcript` only when exact messages or tool activity are required.
5. **Aggregate:** use `daily`, `tool-usage`, `projects`, `stats`, or `export` only when the question needs that view.

```bash
agent-optic sessions --provider pi --since 24h --raw --pretty
agent-optic observe --providers pi,claude,codex --since 24h --privacy shareable
agent-optic evidence <session-id> --provider pi --terms "term one,term two" --max-matches 8 --max-chars 4000 --raw --pretty
agent-optic detail <session-id> --provider pi --raw --pretty
agent-optic transcript <session-id> --provider pi --format jsonl --limit 50
agent-optic daily --date YYYY-MM-DD --raw --pretty
agent-optic tool-usage --from YYYY-MM-DD --to YYYY-MM-DD --raw --pretty
agent-optic export --from YYYY-MM-DD --to YYYY-MM-DD --privacy shareable --raw --pretty
```

Run `agent-optic --help` for the current command and flag reference rather than inferring syntax.

## Interpretation

- `sessions` defaults to today; `--since 24h` is a rolling window.
- Claude is the default provider. Pass `--provider` explicitly for other providers.
- Check `dataCompleteness` and `sourceCapabilities` before claiming that prompts, transcripts, tool calls, tokens, or costs are complete. Cursor is prompt-only; other providers depend on the local stores that are present.
- Prefer `--format jsonl` for large streams, `--raw --pretty` for readable data, and `--fields`/`--limit` to minimize output.
- Local model-cost estimates are limited by the installed pricing table; report unavailable pricing as unavailable, not zero.

## Privacy

Provider directories may contain credentials, private code, and personal data.

- `local` is the default: it removes thinking and tool results but retains prompts and paths.
- `shareable` also redacts home and absolute paths.
- `strict` also redacts user prompts and common credential, email, and IP patterns.
- `--include-tool-results` is an explicit sensitive-data opt-in. Use it only when the question requires tool output, and return the smallest relevant excerpt.

Use `shareable` or `strict` before external sharing. Never treat redaction as proof that arbitrary raw transcript output is safe.