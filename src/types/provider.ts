export const SUPPORTED_PROVIDERS = [
	"claude",
	"codex",
	"openai",
	"cursor",
	"windsurf",
] as const;

export type Provider = (typeof SUPPORTED_PROVIDERS)[number];
