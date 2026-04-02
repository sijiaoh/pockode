import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getAllThemes,
	getThemeInfo,
	isValidTheme,
	registerTheme,
	resetCustomThemes,
	THEME_INFO,
	THEME_NAMES,
	type ThemeInfo,
} from "./themeRegistry";

const BUILTIN_COUNT = THEME_NAMES.length;

function createThemeInfo(overrides: Partial<ThemeInfo> = {}): ThemeInfo {
	return {
		label: "Test",
		description: "Test theme",
		accent: { light: "#000", dark: "#fff" },
		bg: { light: "#fff", dark: "#000" },
		text: { light: "#000", dark: "#fff" },
		textMuted: { light: "#666", dark: "#999" },
		...overrides,
	};
}

describe("themeRegistry", () => {
	afterEach(() => {
		resetCustomThemes();
	});

	describe("registerTheme", () => {
		it("adds theme to getAllThemes", () => {
			registerTheme("custom", createThemeInfo(), ".theme-custom {}");

			expect(getAllThemes()).toHaveLength(BUILTIN_COUNT + 1);
			const custom = getAllThemes().find((t) => t.name === "custom");
			expect(custom).toBeDefined();
			expect(custom?.info.label).toBe("Test");
		});

		it("injects CSS style element into DOM", () => {
			registerTheme("custom", createThemeInfo(), ".theme-custom { --c: 1; }");

			const style = document.getElementById("theme-custom");
			expect(style).not.toBeNull();
			expect(style?.textContent).toBe(".theme-custom { --c: 1; }");
		});

		it("warns on duplicate theme name", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			registerTheme("dup", createThemeInfo(), "");
			registerTheme("dup", createThemeInfo({ label: "Dup2" }), "");

			expect(warnSpy).toHaveBeenCalledWith(
				'Theme "dup" is already registered, overwriting',
			);
			warnSpy.mockRestore();
		});
	});

	describe("unregister", () => {
		it("removes theme from getAllThemes", () => {
			const unregister = registerTheme(
				"custom",
				createThemeInfo(),
				".theme-custom {}",
			);

			expect(getAllThemes()).toHaveLength(BUILTIN_COUNT + 1);
			unregister();
			expect(getAllThemes()).toHaveLength(BUILTIN_COUNT);
		});

		it("removes CSS style element from DOM", () => {
			const unregister = registerTheme(
				"custom",
				createThemeInfo(),
				".theme-custom {}",
			);

			expect(document.getElementById("theme-custom")).not.toBeNull();
			unregister();
			expect(document.getElementById("theme-custom")).toBeNull();
		});
	});

	describe("isValidTheme", () => {
		it("returns true for builtin themes", () => {
			for (const name of THEME_NAMES) {
				expect(isValidTheme(name)).toBe(true);
			}
		});

		it("returns true for registered custom themes", () => {
			registerTheme("custom", createThemeInfo(), "");
			expect(isValidTheme("custom")).toBe(true);
		});

		it("returns false for unknown themes", () => {
			expect(isValidTheme("nonexistent")).toBe(false);
		});
	});

	describe("getThemeInfo", () => {
		it("returns info for builtin themes", () => {
			expect(getThemeInfo("abyss")).toBe(THEME_INFO.abyss);
		});

		it("returns info for custom themes", () => {
			const info = createThemeInfo({ label: "My Theme" });
			registerTheme("custom", info, "");
			expect(getThemeInfo("custom")).toBe(info);
		});

		it("returns undefined for unknown themes", () => {
			expect(getThemeInfo("nonexistent")).toBeUndefined();
		});
	});

	describe("resetCustomThemes", () => {
		it("clears all custom themes", () => {
			registerTheme("a", createThemeInfo(), ".theme-a {}");
			registerTheme("b", createThemeInfo(), ".theme-b {}");

			expect(getAllThemes()).toHaveLength(BUILTIN_COUNT + 2);

			resetCustomThemes();

			expect(getAllThemes()).toHaveLength(BUILTIN_COUNT);
			expect(document.getElementById("theme-a")).toBeNull();
			expect(document.getElementById("theme-b")).toBeNull();
		});
	});
});
