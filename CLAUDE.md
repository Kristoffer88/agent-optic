# CLAUDE.md

## Overview

`agent-optic` — Zero-dependency, local-first TypeScript library for reading assistant session data from provider home directories.

## Architecture

```
src/
  index.ts              # Public API exports
  agent-optic.ts        # Main factory: createHistory()
  types/                # All type definitions (one file per domain)
  readers/              # File readers (history.jsonl, session JSONL, tasks, plans, projects, stats, provider-specific session readers)
  parsers/              # Session transcript parsing, tool categorization, content block extraction
  aggregations/         # Daily summaries, project summaries, tool usage, time estimation
  privacy/              # Redaction engine, privacy profiles, credential detection
  utils/                # Dates, paths, provider helpers
  cli/                  # CLI commands (sessions, projects, stats, export)
```

## Key Design Decisions

- **Zero runtime dependencies.** Bun provides file I/O, JSON parsing, path handling. Every dependency is an attack surface for the most sensitive directory on a developer's machine.
- **No network imports.** No `http`, `https`, `fetch`, `net`, `dns`, `WebSocket` anywhere in the codebase.
- **Bun-native.** `Bun.file()`, `Bun.Glob`, `Bun.write()`.
- **Privacy by default.** `toolUseResult` content and thinking blocks are stripped before data reaches consumers.
- **Two-tier session loading.** `list()` reads only `history.jsonl` (fast). `listWithMeta()` also reads session files for branch/model/tokens (slower).
- **Provider dispatch.** Provider-specific branches cover Claude (default), Codex/OpenAI, Pi, Copilot, Cursor, Claude Desktop, and OpenCode. Each has its own session format and path layout. Pi, Copilot, Cursor, Claude Desktop, and OpenCode have no `history.jsonl` — sessions are discovered by directory/database/metadata scan. Cursor, Claude Desktop, and OpenCode are currently metadata-level where full transcripts are not exposed locally.

## Conventions

- All dates are `YYYY-MM-DD` strings in local time
- Session IDs are UUIDs
- Project paths are encoded with `/` → `-` for filesystem storage (Claude/Codex) or `--`-wrapped with `-` separators (Pi)
- JSONL files are newline-delimited JSON, one record per line

## Security Rules

- NEVER add runtime dependencies
- NEVER import network modules
- NEVER write files outside of explicit user-directed output
- Always apply privacy redaction before returning data
