import type { SessionMode } from "./message";

export type AgentType = "claude" | "codex";

export interface Settings {
	default_agent_role_id?: string;
	default_agent_type?: AgentType;
	default_mode?: SessionMode;
	// Empty = default (a `<repo>-worktrees` directory next to the repository).
	// Non-empty must be an absolute, clean path; the backend rejects invalid values.
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
