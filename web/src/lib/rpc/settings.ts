import type { JSONRPCRequester } from "json-rpc-2.0";
import type { Settings } from "../../types/settings";
import { useSettingsStore } from "../settingsStore";

export interface SettingsActions {
	updateSettings: (patch: Partial<Settings>) => Promise<void>;
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
		// Merge with current settings to avoid overwriting unrelated fields
		updateSettings: async (patch: Partial<Settings>): Promise<void> => {
			const current = useSettingsStore.getState().settings ?? {};
			const settings: Settings = { ...current, ...patch };
			await requireClient().request("settings.update", { settings });
		},
	};
}
