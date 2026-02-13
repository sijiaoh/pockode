import { afterEach, describe, expect, it, vi } from "vitest";
import type { Extension } from "./extensions";
import { resetSettingsSections } from "./registries/settingsRegistry";

function createExtension(overrides: Partial<Extension> = {}): Extension {
	return { id: "test", activate: vi.fn(), ...overrides };
}

async function importExtensions() {
	return import("./extensions");
}

describe("extensions", () => {
	afterEach(() => {
		vi.resetModules();
		resetSettingsSections();
	});

	describe("loadExtension", () => {
		it("activates extension with context containing extension id", async () => {
			const { loadExtension, unloadExtension, isExtensionLoaded } =
				await importExtensions();

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

		it("rejects duplicate extension id", async () => {
			const { loadExtension, unloadExtension } = await importExtensions();
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
		it("cleans up registrations", async () => {
			const { loadExtension, unloadExtension, isExtensionLoaded } =
				await importExtensions();
			const { getSettingsSections } = await import(
				"./registries/settingsRegistry"
			);

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

		it("returns false for non-existent extension", async () => {
			const { unloadExtension } = await importExtensions();

			expect(unloadExtension("non-existent")).toBe(false);
		});
	});

	describe("settings.register", () => {
		it("namespaces section id with extension id", async () => {
			const { loadExtension, unloadExtension } = await importExtensions();
			const { getSettingsSections } = await import(
				"./registries/settingsRegistry"
			);

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
		it("returns all loaded extension ids", async () => {
			const { loadExtension, unloadExtension, getLoadedExtensions } =
				await importExtensions();

			loadExtension(createExtension({ id: "ext-a" }));
			loadExtension(createExtension({ id: "ext-b" }));

			expect(getLoadedExtensions()).toEqual(["ext-a", "ext-b"]);

			unloadExtension("ext-a");
			unloadExtension("ext-b");
		});
	});
});
