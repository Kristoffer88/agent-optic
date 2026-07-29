# Changelog

## Unreleased

- Security: validate session identifiers before interpolating them into file paths and globs, closing a path-traversal vector where a crafted `history.jsonl`/session id (`../…`) could read `.jsonl` files outside the provider directory (Claude/Pi/Codex resolvers).
- Security: expand `strict`-profile credential detection to also redact OpenAI/Anthropic `sk-`/`sk-proj-`/`sk-ant-` keys, JWTs, PEM private-key blocks, Slack, Google, GitLab, GitHub fine-grained, and npm tokens; all patterns remain linear (no ReDoS).
- Security: run string redaction over free-text transcript fields outside `message.content` (`planContent`, `error`, `slug`, summary) so secrets/paths there no longer bypass `shareable`/`strict`.
- Security: honor the active privacy profile when reading tasks, todos, and plans, so `daily`/`export` no longer emit unredacted task/plan/todo text.

## 0.6.1

- Avoid reading and parsing Claude transcript files for sessions already represented in `history.jsonl`, preserving fallback discovery while making history-backed session lists substantially faster.

## 0.6.0

- Add the versioned `agent-optic.observation/v1` API and `observe` CLI command for bounded, multi-provider session facts and provider health.
- Canonicalize the `openai` local-history alias to `codex` so their shared store is observed once.
- Add explicit observation capabilities, completeness, deterministic ordering, provider errors, date filters, and privacy metadata.
- Add privacy-safe Pi lifecycle roles, stop reasons, and timestamps using closed vocabularies.
- Strengthen shareable path minimization in prompts, transcripts, tool inputs, and provider errors, including home paths containing spaces.
- Preserve existing machine-readable evidence-limit errors while adding observation-specific bounds.
- Add deterministic lifecycle, privacy, CLI, contract, and package validation.
