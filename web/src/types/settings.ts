export interface Settings {
	default_agent_role_id?: string;
}

export interface SettingsSubscribeResult {
	id: string;
	settings: Settings;
}

export interface SettingsChangedNotification {
	id: string;
	settings: Settings;
}
