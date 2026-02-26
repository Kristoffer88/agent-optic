export const SUPPORTED_PROVIDERS = ["claude", "codex", "cursor", "windsurf"] as const;

export type Provider = (typeof SUPPORTED_PROVIDERS)[number];
