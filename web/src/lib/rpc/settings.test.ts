import type { JSONRPCRequester } from "json-rpc-2.0";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../settingsStore";
import { createSettingsActions } from "./settings";

describe("updateSettings", () => {
	const request = vi.fn(async () => undefined);
	const client = { request } as unknown as JSONRPCRequester<void>;
	const actions = createSettingsActions(() => client);

	beforeEach(() => {
		request.mockClear();
		useSettingsStore.getState().reset();
	});

	it("refuses to write before the snapshot arrives", async () => {
		await expect(
			actions.updateSettings({ default_mode: "yolo" }),
		).rejects.toThrow(/default_mode.*before the settings snapshot arrives/);
		expect(request).not.toHaveBeenCalled();
	});

	it("merges the patch into the snapshot", async () => {
		useSettingsStore.getState().setSettings({
			worktree_base_dir: "~/trees",
			default_agent_role_id: "role-1",
		});

		await actions.updateSettings({ default_mode: "yolo" });

		expect(request).toHaveBeenCalledWith("settings.update", {
			settings: {
				worktree_base_dir: "~/trees",
				default_agent_role_id: "role-1",
				default_mode: "yolo",
			},
		});
	});

	it("reports a missing connection rather than a missing snapshot", async () => {
		const offline = createSettingsActions(() => null);
		await expect(
			offline.updateSettings({ default_mode: "yolo" }),
		).rejects.toThrow("Not connected");
	});
});
