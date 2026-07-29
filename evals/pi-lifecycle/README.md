# Pi lifecycle extraction eval

Manual deterministic release eval for privacy-safe Pi lifecycle fields consumed by downstream session monitors.

Run:

```bash
bun run eval:pi-lifecycle
```

Four raw JSONL replays cover assistant completion, a tool result, a malformed trailing record, and an undated message. The candidate is compared with the previous `SessionInfo` contract, where lifecycle fields were absent. Strict privacy output is checked for transcript-content leakage.

The mode-`0600` receipt is written to `out/receipt.json`; override it with `AGENT_OPTIC_PI_LIFECYCLE_EVAL_OUT`. No model is used because extraction and privacy are deterministic contracts.

Do not expose the capability if the latest valid role/stop/timestamp tuple is wrong, `lifecycle-event` is missing, or private transcript content leaks into strict `SessionInfo` output.
