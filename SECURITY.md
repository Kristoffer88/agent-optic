# Security

`~/.claude/` contains your full Claude Code session history — prompts, source code, credentials, file paths. Treat it like your shell history and SSH keys combined.

## How this library handles it

- **Zero dependencies.** Nothing to get supply-chained.
- **No network access.** No `http`, `fetch`, `net`, `dns`, or `WebSocket` anywhere in the codebase.
- **Privacy profiles** strip sensitive fields before data reaches your code:

| Profile | Strips |
|---------|--------|
| `local` (default) | Tool results, thinking blocks |
| `shareable` | + absolute paths, home directory |
| `strict` | + prompt text, emails, credential patterns, IPs |

Regex can't catch everything. Review output before sharing.

## Reporting vulnerabilities

Open a GitHub issue or email.
