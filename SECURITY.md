# Security

`~/.claude/`, `~/.codex/`, `~/.pi/`, `~/.copilot/`, Cursor app storage, Claude Desktop storage, OpenCode Desktop storage, and similar provider directories can contain raw assistant session data, including prompts, outputs, tool activity, and file paths.

## How this library handles it

- **Zero runtime package dependencies.** This reduces third-party runtime supply-chain surface.
- **No network access in shipped runtime source.** It does not import or call `http`, `fetch`, `net`, `dns`, or `WebSocket`.
- **Privacy profiles** strip sensitive fields before data reaches your code:

| Profile | Strips |
|---------|--------|
| `local` (default) | Tool results, thinking blocks |
| `shareable` | + home-rooted paths inside prompt and transcript text |
| `strict` | + prompt text, emails, credential patterns, IPs |

Project identity and other metadata fields can still contain absolute paths because local consumers use them for correlation. Privacy profiles are minimization controls, not authorization to publish output. Review and independently scan exact outbound data before sharing it.

## Reporting vulnerabilities

Open a GitHub issue.
