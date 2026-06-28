export const SUPPORTED_PROVIDERS = [
	"claude",
	"codex",
	"openai",
	"pi",
	"copilot",
	"cursor",
	"claude-desktop",
	"opencode",
] as const;

export type Provider = (typeof SUPPORTED_PROVIDERS)[number];
