export const SUPPORTED_PROVIDERS = [
	"claude",
	"codex",
	"openai",
	"pi",
	"copilot",
] as const;

export type Provider = (typeof SUPPORTED_PROVIDERS)[number];
