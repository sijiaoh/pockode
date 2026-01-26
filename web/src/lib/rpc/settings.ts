import type { JSONRPCRequester } from "json-rpc-2.0";
import type { Settings } from "../../types/settings";

export interface SettingsActions {
	getSettings: () => Promise<Settings>;
	updateSettings: (settings: Settings) => Promise<void>;
}

export function createSettingsActions(
	getClient: () => JSONRPCRequester<void> | null,
): SettingsActions {
	const requireClient = (): JSONRPCRequester<void> => {
		const client = getClient();
		if (!client) {
			throw new Error("Not connected");
		}
		return client;
	};

	return {
		getSettings: async (): Promise<Settings> => {
			return requireClient().request("settings.get", {});
		},

		updateSettings: async (settings: Settings): Promise<void> => {
			await requireClient().request("settings.update", { settings });
		},
	};
}
