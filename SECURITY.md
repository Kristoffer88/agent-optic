# Security

`~/.claude/`, `~/.codex/`, `~/.pi/`, and similar provider directories can contain raw assistant session data, including prompts, outputs, tool activity, and file paths.

## How this library handles it

- **Zero dependencies.** Nothing to get supply-chained.
- **No network access.** No `http`, `fetch`, `net`, `dns`, or `WebSocket` anywhere in the codebase.
- **Privacy profiles** strip sensitive fields before data reaches your code:

| Profile | Strips |
|---------|--------|
| `local` (default) | Tool results, thinking blocks |
| `shareable` | + absolute paths, home directory |
| `strict` | + prompt text, emails, IPs |

Review output before sharing.

## Reporting vulnerabilities

Open a GitHub issue.
