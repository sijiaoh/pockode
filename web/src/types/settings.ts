import type { SessionMode } from "./message";

export interface Settings {
	default_agent_role_id?: string;
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
