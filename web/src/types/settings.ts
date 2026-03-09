import type { SessionMode } from "./message";

export type AgentType = "claude" | "codex";

export interface Settings {
	default_agent_role_id?: string;
	default_agent_type?: AgentType;
	default_mode?: SessionMode;
}

export interface SettingsSubscribeResult {
	id: string;
	settings: Settings;
}

export interface SettingsChangedNotification {
	id: string;
	settings: Settings;
}
