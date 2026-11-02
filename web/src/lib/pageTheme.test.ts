import { describe, expect, it } from "vitest";
import {
	followsTheme,
	pageBaseCss,
	pageBaseStylesheet,
	pageThemeFrom,
} from "./pageTheme";

describe("followsTheme", () => {
	it.each([
		"<style>body{background:var(--pk-bg)}</style>",
		"<style>:root{--pk-accent: hotpink}</style>",
		'<p style="color:var(--pk-text-muted)">x</p>',
		"<style>a{color:var(--pk-text,#000)}</style>",
		"--pk-code-text",
	])("follows the theme when the page names one of its variables: %s", (html) => {
		expect(followsTheme(html)).toBe(true);
	});

	it.each([
		"<p>plain</p>",
		"<style>:root{--pk-gap:4px}</style>",
		"<style>a{color:var(--pk-bgx)}</style>",
		"<style>a{color:var(--pk-bg_2)}</style>",
		"<style>a{color:var(--pk-bg-secondaryé)}</style>",
		"<style>a{color:var(--pk-text-)}</style>",
		"<style>a{color:var(--x--pk-bg)}</style>",
		"<style>a{color:var(---pk-bg)}</style>",
		"<style>a{color:var(é--pk-bg)}</style>",
	])("does not for a name of the page's own: %s", (html) => {
		expect(followsTheme(html)).toBe(false);
	});
});

describe("pageThemeFrom", () => {
	it("takes each variable from the app token it maps to, and leaves out what is unset", () => {
		const style = document.createElement("div").style;
		style.setProperty("--th-bg-primary", " #101010 ");
		style.setProperty("--th-accent", "#3366ff");

		expect(pageThemeFrom(style, "dark")).toEqual({
			scheme: "dark",
			vars: { "--pk-bg": "#101010", "--pk-accent": "#3366ff" },
		});
	});
});

describe("the base stylesheet", () => {
	it("weighs nothing and sits in its own layer, so every rule of the agent's wins", () => {
		const css = pageBaseCss({ scheme: "light", vars: {} });
		expect(css.startsWith("@layer pockode-base{")).toBe(true);
		// Every rule's selector is a :where(), whatever media query wraps it.
		const selectors = css
			.slice("@layer pockode-base{".length)
			.replace(/@media[^{]*\{/g, "")
			.split("}")
			.map((rule) => rule.split("{")[0].trim())
			.filter(Boolean);
		expect(selectors.length).toBeGreaterThan(5);
		for (const selector of selectors) expect(selector).toMatch(/^:where\(/);
	});

	it("puts the scheme and the variables on the root", () => {
		expect(
			pageBaseCss({ scheme: "dark", vars: { "--pk-bg": "#000" } }),
		).toContain(":where(:root){color-scheme:dark;--pk-bg:#000;");
	});

	it("cannot be closed early by a value", () => {
		const markup = pageBaseStylesheet({
			scheme: "light",
			vars: { "--pk-bg": "</style><script>x()</script>" },
		});
		expect(markup.indexOf("</style>")).toBe(markup.length - "</style>".length);
	});
});
