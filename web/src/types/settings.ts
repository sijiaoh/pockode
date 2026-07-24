import type { SessionMode } from "./message";

export type AgentType = "claude" | "codex";

export interface Settings {
	default_agent_role_id?: string;
	default_agent_type?: AgentType;
	default_mode?: SessionMode;
	// Empty = default (`../<repo>-worktrees`). Non-empty may be an absolute path,
	// a repo-relative `./`/`../` path, or a home-relative `~/` path; the backend
	// validates and rejects invalid values.
	worktree_base_dir?: string;
}

export interface SettingsSubscribeResult {
	id: string;
	settings: Settings;
}

export interface SettingsChangedNotification {
	id: string;
	settings: Settings;
}
