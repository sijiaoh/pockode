import { afterEach, describe, expect, it } from "vitest";
import {
	getSettingsSections,
	registerSettingsSection,
	resetSettingsSections,
} from "./settingsRegistry";

describe("settingsRegistry", () => {
	afterEach(() => {
		resetSettingsSections();
	});

	it("registers a section", () => {
		registerSettingsSection({
			id: "test",
			label: "Test",
			priority: 10,
			component: () => null,
		});

		expect(getSettingsSections()).toHaveLength(1);
		expect(getSettingsSections()[0].id).toBe("test");
	});

	it("sorts sections by priority", () => {
		registerSettingsSection({
			id: "low",
			label: "Low",
			priority: 100,
			component: () => null,
		});
		registerSettingsSection({
			id: "high",
			label: "High",
			priority: 10,
			component: () => null,
		});

		const sections = getSettingsSections();
		expect(sections[0].id).toBe("high");
		expect(sections[1].id).toBe("low");
	});

	it("unregisters a section", () => {
		const unregister = registerSettingsSection({
			id: "test",
			label: "Test",
			priority: 10,
			component: () => null,
		});

		expect(getSettingsSections()).toHaveLength(1);
		unregister();
		expect(getSettingsSections()).toHaveLength(0);
	});
});
