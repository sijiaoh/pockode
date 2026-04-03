import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeInfo } from "./registries/themeRegistry";

const NEON_THEME: ThemeInfo = {
	label: "Neon",
	description: "Neon glow",
	accent: { light: "#e91e63", dark: "#f48fb1" },
	bg: { light: "#fff", dark: "#1a0011" },
	text: { light: "#1a0011", dark: "#fff" },
	textMuted: { light: "#880e4f", dark: "#f48fb1" },
};

describe("themeStore", () => {
	beforeEach(() => {
		vi.resetModules();
		localStorage.clear();
		document.documentElement.className = "";
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("initial state", () => {
		it("uses stored mode when valid", async () => {
			localStorage.setItem("theme-mode", "dark");

			const { useThemeStore } = await import("./themeStore");
			expect(useThemeStore.getState().mode).toBe("dark");
		});

		it("defaults to system mode when no stored value", async () => {
			const { useThemeStore } = await import("./themeStore");
			expect(useThemeStore.getState().mode).toBe("system");
		});

		it("defaults to system mode when stored value is invalid", async () => {
			localStorage.setItem("theme-mode", "invalid");

			const { useThemeStore } = await import("./themeStore");
			expect(useThemeStore.getState().mode).toBe("system");
		});

		it("uses stored theme when valid", async () => {
			localStorage.setItem("theme-name", "aurora");

			const { useThemeStore } = await import("./themeStore");
			expect(useThemeStore.getState().theme).toBe("aurora");
		});

		it("defaults to abyss theme when no stored value", async () => {
			const { useThemeStore } = await import("./themeStore");
			expect(useThemeStore.getState().theme).toBe("abyss");
		});

		it("preserves stored custom theme name before registration", async () => {
			localStorage.setItem("theme-name", "neon");

			const { useThemeStore } = await import("./themeStore");
			expect(useThemeStore.getState().theme).toBe("neon");
		});
	});

	describe("themeActions.setMode", () => {
		it("updates mode in storage and state", async () => {
			const { useThemeStore, themeActions } = await import("./themeStore");

			themeActions.setMode("dark");

			expect(localStorage.getItem("theme-mode")).toBe("dark");
			expect(useThemeStore.getState().mode).toBe("dark");
		});

		it("applies dark class to DOM when mode is dark", async () => {
			const { themeActions } = await import("./themeStore");

			themeActions.setMode("dark");

			expect(document.documentElement.classList.contains("dark")).toBe(true);
		});

		it("removes dark class from DOM when mode is light", async () => {
			const { themeActions } = await import("./themeStore");

			themeActions.setMode("dark");
			themeActions.setMode("light");

			expect(document.documentElement.classList.contains("dark")).toBe(false);
		});

		it("updates resolvedMode based on mode", async () => {
			const { useThemeStore, themeActions } = await import("./themeStore");

			themeActions.setMode("dark");
			expect(useThemeStore.getState().resolvedMode).toBe("dark");

			themeActions.setMode("light");
			expect(useThemeStore.getState().resolvedMode).toBe("light");
		});
	});

	describe("themeActions.setTheme", () => {
		it("updates theme in storage and state", async () => {
			const { useThemeStore, themeActions } = await import("./themeStore");

			themeActions.setTheme("ember");

			expect(localStorage.getItem("theme-name")).toBe("ember");
			expect(useThemeStore.getState().theme).toBe("ember");
		});

		it("applies theme class to DOM", async () => {
			const { themeActions } = await import("./themeStore");

			themeActions.setTheme("mint");

			expect(document.documentElement.classList.contains("theme-mint")).toBe(
				true,
			);
		});

		it("removes previous theme class when switching", async () => {
			const { themeActions } = await import("./themeStore");

			themeActions.setTheme("aurora");
			themeActions.setTheme("void");

			expect(document.documentElement.classList.contains("theme-aurora")).toBe(
				false,
			);
			expect(document.documentElement.classList.contains("theme-void")).toBe(
				true,
			);
		});

		it("switches to a registered custom theme", async () => {
			const { registerTheme, resetCustomThemes } = await import(
				"./registries/themeRegistry"
			);
			const { useThemeStore, themeActions } = await import("./themeStore");

			registerTheme("neon", NEON_THEME, ".theme-neon { --accent: #e91e63; }");

			themeActions.setTheme("neon");

			expect(useThemeStore.getState().theme).toBe("neon");
			expect(localStorage.getItem("theme-name")).toBe("neon");
			expect(document.documentElement.classList.contains("theme-neon")).toBe(
				true,
			);

			resetCustomThemes();
		});

		it("rejects unregistered custom theme", async () => {
			const { useThemeStore, themeActions } = await import("./themeStore");
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			themeActions.setTheme("abyss");
			themeActions.setTheme("nonexistent");

			expect(warnSpy).toHaveBeenCalledWith("Invalid theme: nonexistent");
			expect(useThemeStore.getState().theme).toBe("abyss");
			expect(
				document.documentElement.classList.contains("theme-nonexistent"),
			).toBe(false);

			warnSpy.mockRestore();
		});

		it("removes previous builtin theme class when switching to custom", async () => {
			const { registerTheme, resetCustomThemes } = await import(
				"./registries/themeRegistry"
			);
			const { themeActions } = await import("./themeStore");

			registerTheme("neon", NEON_THEME, ".theme-neon { --accent: #e91e63; }");

			themeActions.setTheme("ember");
			themeActions.setTheme("neon");

			expect(document.documentElement.classList.contains("theme-ember")).toBe(
				false,
			);
			expect(document.documentElement.classList.contains("theme-neon")).toBe(
				true,
			);

			resetCustomThemes();
		});
	});

	describe("themeActions.init", () => {
		it("applies stored theme to DOM on init", async () => {
			localStorage.setItem("theme-mode", "dark");
			localStorage.setItem("theme-name", "ember");

			const { themeActions } = await import("./themeStore");
			themeActions.init();

			expect(document.documentElement.classList.contains("dark")).toBe(true);
			expect(document.documentElement.classList.contains("theme-ember")).toBe(
				true,
			);
		});

		it("is idempotent — second call is a no-op", async () => {
			localStorage.setItem("theme-name", "ember");

			const { themeActions } = await import("./themeStore");
			themeActions.init();

			// Manually remove class to detect if init re-applies
			document.documentElement.classList.remove("theme-ember");
			themeActions.init();

			expect(document.documentElement.classList.contains("theme-ember")).toBe(
				false,
			);
		});

		it("applies custom theme once when extension registers it", async () => {
			localStorage.setItem("theme-name", "neon");

			const { registerTheme, resetCustomThemes } = await import(
				"./registries/themeRegistry"
			);
			const { useThemeStore, themeActions } = await import("./themeStore");

			// Store preserves the custom theme name before registration
			expect(useThemeStore.getState().theme).toBe("neon");

			themeActions.init();

			// init() defers DOM application for unregistered custom themes
			expect(document.documentElement.classList.contains("theme-abyss")).toBe(
				false,
			);
			expect(document.documentElement.classList.contains("theme-neon")).toBe(
				false,
			);

			// Extension registers the theme — applied to DOM for the first time
			registerTheme("neon", NEON_THEME, ".theme-neon { --accent: #e91e63; }");

			expect(useThemeStore.getState().theme).toBe("neon");
			expect(document.documentElement.classList.contains("theme-neon")).toBe(
				true,
			);

			resetCustomThemes();
		});

		it("falls back to default when active custom theme is unregistered", async () => {
			localStorage.setItem("theme-name", "neon");

			const { registerTheme } = await import("./registries/themeRegistry");
			const { useThemeStore, themeActions } = await import("./themeStore");

			themeActions.init();

			const unregister = registerTheme(
				"neon",
				NEON_THEME,
				".theme-neon { --accent: #e91e63; }",
			);
			expect(useThemeStore.getState().theme).toBe("neon");

			// Unregister — should fall back to "abyss"
			unregister();

			expect(useThemeStore.getState().theme).toBe("abyss");
			expect(localStorage.getItem("theme-name")).toBe("abyss");
			expect(document.documentElement.classList.contains("theme-neon")).toBe(
				false,
			);
			expect(document.documentElement.classList.contains("theme-abyss")).toBe(
				true,
			);
		});
	});
});
