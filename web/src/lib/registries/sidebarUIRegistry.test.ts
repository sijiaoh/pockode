import { afterEach, describe, expect, it } from "vitest";
import {
	getSidebarUIConfig,
	resetSidebarUIConfig,
	setSidebarUIConfig,
} from "./sidebarUIRegistry";

afterEach(() => {
	resetSidebarUIConfig();
});

describe("sidebarUIConfig", () => {
	it("sets config values", () => {
		const Component = () => null;
		setSidebarUIConfig({ SidebarContent: Component });

		expect(getSidebarUIConfig().SidebarContent).toBe(Component);
	});

	it("merges config with existing values", () => {
		const Component1 = () => null;
		const Component2 = () => null;
		setSidebarUIConfig({ SidebarContent: Component1 });
		setSidebarUIConfig({ SidebarContent: Component2 });

		expect(getSidebarUIConfig().SidebarContent).toBe(Component2);
	});

	it("resets config to default", () => {
		setSidebarUIConfig({ SidebarContent: () => null });
		resetSidebarUIConfig();

		expect(getSidebarUIConfig().SidebarContent).toBeUndefined();
	});
});
