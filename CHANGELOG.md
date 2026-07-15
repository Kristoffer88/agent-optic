# Changelog

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
