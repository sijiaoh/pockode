import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type Extension,
	getLoadedExtensions,
	isExtensionLoaded,
	loadExtension,
	unloadExtension,
} from "./extensions";
import { resetChatUIConfig } from "./registries/chatUIRegistry";
import {
	getSettingsSections,
	resetSettingsSections,
} from "./registries/settingsRegistry";
import {
	getSidebarUIConfig,
	resetSidebarUIConfig,
} from "./registries/sidebarUIRegistry";
import { getAllThemes, resetCustomThemes } from "./themeStore";

function createExtension(overrides: Partial<Extension> = {}): Extension {
	return { id: "test", activate: vi.fn(), ...overrides };
}

describe("extensions", () => {
	afterEach(() => {
		for (const id of getLoadedExtensions()) {
			unloadExtension(id);
		}
		resetSettingsSections();
		resetChatUIConfig();
		resetSidebarUIConfig();
		resetCustomThemes();
	});

	describe("loadExtension", () => {
		it("activates extension with context containing extension id", () => {
			const activate = vi.fn();
			const result = loadExtension(createExtension({ activate }));

			expect(result).toBe(true);
			expect(activate).toHaveBeenCalledOnce();
			expect(activate).toHaveBeenCalledWith(
				expect.objectContaining({ id: "test" }),
			);
			expect(isExtensionLoaded("test")).toBe(true);

			unloadExtension("test");
		});

		it("rejects duplicate extension id", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const activate = vi.fn();
			const first = loadExtension(createExtension({ activate }));
			const second = loadExtension(createExtension({ activate }));

			expect(first).toBe(true);
			expect(second).toBe(false);
			expect(activate).toHaveBeenCalledOnce();
			expect(warnSpy).toHaveBeenCalledWith(
				'Extension "test" is already loaded',
			);

			warnSpy.mockRestore();
			unloadExtension("test");
		});
	});

	describe("unloadExtension", () => {
		it("cleans up registrations", () => {
			loadExtension(
				createExtension({
					activate: (ctx) => {
						ctx.settings.register({
							id: "section",
							label: "Test",
							priority: 10,
							component: () => null,
						});
					},
				}),
			);

			expect(getSettingsSections()).toHaveLength(1);
			expect(isExtensionLoaded("test")).toBe(true);

			const result = unloadExtension("test");

			expect(result).toBe(true);
			expect(getSettingsSections()).toHaveLength(0);
			expect(isExtensionLoaded("test")).toBe(false);
		});

		it("cleans up sidebarUI config", () => {
			const Component = () => null;
			loadExtension(
				createExtension({
					activate: (ctx) => {
						ctx.sidebarUI.configure({ SidebarContent: Component });
					},
				}),
			);

			expect(getSidebarUIConfig().SidebarContent).toBe(Component);

			unloadExtension("test");

			expect(getSidebarUIConfig().SidebarContent).toBeUndefined();
		});

		it("cleans up registered themes", () => {
			loadExtension(
				createExtension({
					activate: (ctx) => {
						ctx.theme.register(
							"test-theme",
							{
								label: "Test",
								description: "Test theme",
								accent: { light: "#000", dark: "#fff" },
								bg: { light: "#fff", dark: "#000" },
								text: { light: "#000", dark: "#fff" },
								textMuted: { light: "#666", dark: "#999" },
							},
							".theme-test-theme { --th-accent: #000; }",
						);
					},
				}),
			);

			const builtinCount = 5;
			expect(getAllThemes()).toHaveLength(builtinCount + 1);

			unloadExtension("test");

			expect(getAllThemes()).toHaveLength(builtinCount);
		});

		it("returns false for non-existent extension", () => {
			expect(unloadExtension("non-existent")).toBe(false);
		});
	});

	describe("settings.register", () => {
		it("namespaces section id with extension id", () => {
			loadExtension(
				createExtension({
					id: "my-ext",
					activate: (ctx) => {
						ctx.settings.register({
							id: "section",
							label: "Test",
							priority: 10,
							component: () => null,
						});
					},
				}),
			);

			expect(getSettingsSections()).toEqual([
				expect.objectContaining({ id: "my-ext.section" }),
			]);

			unloadExtension("my-ext");
		});
	});

	describe("getLoadedExtensions", () => {
		it("returns all loaded extension ids", () => {
			loadExtension(createExtension({ id: "ext-a" }));
			loadExtension(createExtension({ id: "ext-b" }));

			expect(getLoadedExtensions()).toEqual(["ext-a", "ext-b"]);

			unloadExtension("ext-a");
			unloadExtension("ext-b");
		});
	});
});
