export const SUPPORTED_PROVIDERS = [
	"claude",
	"codex",
	"openai",
	"cursor",
	"windsurf",
	"pi",
] as const;

export type Provider = (typeof SUPPORTED_PROVIDERS)[number];
