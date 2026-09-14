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
		// `settings.update` replaces the stored object rather than patching it, so
		// a caller that has not seen the subscription snapshot has nothing
		// truthful to send: merging the patch into an empty object would write
		// every untouched field back as its zero value. Refusing is the honest
		// answer — waiting for the snapshot is the caller's job, not something
		// this layer can fake by guessing what the current settings are.
		updateSettings: async (patch: Partial<Settings>): Promise<void> => {
			const client = requireClient();
			const current = useSettingsStore.getState().settings;
			if (!current) {
				throw new Error(
					`Cannot update settings (${Object.keys(patch).join(", ")}) before the settings snapshot arrives`,
				);
			}
			const settings: Settings = { ...current, ...patch };
			await client.request("settings.update", { settings });
		},
	};
}
