import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetPageHosts } from "../../lib/pageHosts";
import {
	registerTheme,
	resetCustomThemes,
	THEME_INFO,
} from "../../lib/registries/themeRegistry";
import { themeActions, useThemeStore } from "../../lib/themeStore";
import { HtmlFrame } from "./HtmlFrame";

// The theme against real frames: what a page is drawn in, and what reaches it
// on a theme change, are the engines' cascade and messaging.

/** Every `signal` a page posts the test, as it arrives. */
let signals: string[] = [];
function onSignal(event: MessageEvent) {
	const data: unknown = event.data;
	if (data && typeof data === "object" && "signal" in data) {
		signals.push(String(data.signal));
	}
}

/**
 * Says each load of the document, and — after each theme the app posts has
 * been applied — the scheme and ground its root then has.
 */
const PROBE = `<script>
parent.parent.postMessage({signal:"load"},"*");
addEventListener("message",function(e){
  if(!e.data||e.data.type!=="pockode:page-theme")return;
  setTimeout(function(){
    var s=getComputedStyle(document.documentElement);
    parent.parent.postMessage({signal:"themed:"+s.colorScheme+":"+s.backgroundColor},"*");
  },0);
});
</script>`;

const THEMED = `<style>body{color:var(--pk-text)}</style><input id="f">${PROBE}`;

function renderPage(html: string) {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<HtmlFrame
				html={html}
				title="Page"
				pageKey="call-1"
				boxStyle={{ height: 120 }}
			/>
		</QueryClientProvider>,
	);
	return screen.getByTitle<HTMLIFrameElement>("Page");
}

function appToken(name: string): string {
	return getComputedStyle(document.documentElement)
		.getPropertyValue(name)
		.trim();
}

describe("a page that follows the theme", () => {
	beforeEach(() => {
		signals = [];
		window.addEventListener("message", onSignal);
		themeActions.setMode("light");
	});
	afterEach(() => {
		window.removeEventListener("message", onSignal);
		themeActions.setMode("light");
		resetPageHosts();
	});

	it("is hidden until it is ready, on the theme's ground, and then shown", async () => {
		themeActions.setMode("dark");
		const drawnAt = performance.now();
		const frame = renderPage(THEMED);
		expect(frame.style.visibility).toBe("hidden");
		expect(frame.style.colorScheme).toBe("dark");
		expect(frame).toHaveClass("bg-th-bg-primary");
		expect(frame.parentElement).toHaveClass("bg-th-bg-primary");

		// The probe says it loaded just before the bridge says it is ready.
		await waitFor(() => expect(signals).toContain("load"));
		const loadedAt = performance.now();
		await waitFor(() => expect(frame.style.visibility).toBe(""), {
			timeout: 500,
		});
		// Shown by the ready, not by the two seconds' fallback — which a slow
		// machine may reach before the page loads, leaving nothing to tell.
		if (loadedAt - drawnAt < 1500) {
			expect(performance.now() - drawnAt).toBeLessThan(2000);
		}
	});

	it("follows a theme change live, without loading again", async () => {
		const frame = renderPage(THEMED);
		await waitFor(() => expect(signals).toContain("load"));
		await waitFor(() => expect(frame.style.visibility).toBe(""));
		signals = [];

		themeActions.setMode("dark");

		const ground = appToken("--th-bg-primary");
		await waitFor(() =>
			expect(signals.some((s) => s.startsWith("themed:dark:"))).toBe(true),
		);
		const themed = signals.find((s) => s.startsWith("themed:dark:"));
		// The page's ground is the app's, as the browser resolves it.
		const probe = document.createElement("div");
		probe.style.backgroundColor = ground;
		document.body.append(probe);
		expect(themed).toBe(
			`themed:dark:${getComputedStyle(probe).backgroundColor}`,
		);
		probe.remove();
		expect(signals).not.toContain("load");
		expect(frame.style.colorScheme).toBe("dark");
	});
});

// A custom theme an extension registers after the app started: the store's
// theme name was set before, so nothing in the store changes when it lands.
describe("a page that follows a custom theme", () => {
	const root = document.documentElement;
	let classes = "";
	beforeEach(() => {
		signals = [];
		window.addEventListener("message", onSignal);
		themeActions.setMode("light");
		classes = root.className;
	});
	afterEach(() => {
		window.removeEventListener("message", onSignal);
		resetCustomThemes();
		root.className = classes;
		useThemeStore.setState({ theme: "abyss" });
		resetPageHosts();
	});

	it("takes the palette when the theme is registered", async () => {
		useThemeStore.setState({ theme: "late" });
		const frame = renderPage(THEMED);
		await waitFor(() => expect(frame.style.visibility).toBe(""));
		signals = [];

		// As the store's registry subscriber does, before any other hears it.
		root.className = "theme-late";
		registerTheme(
			"late",
			THEME_INFO.abyss,
			".theme-late{--th-bg-primary:rgb(1, 2, 3)}",
		);

		await waitFor(() => expect(signals).toContain("themed:light:rgb(1, 2, 3)"));
	});
});

describe("a page that does not ask", () => {
	beforeEach(() => {
		signals = [];
		window.addEventListener("message", onSignal);
	});
	afterEach(() => {
		window.removeEventListener("message", onSignal);
		themeActions.setMode("light");
		resetPageHosts();
	});

	it("stays white, shown at once, and is posted nothing", async () => {
		themeActions.setMode("dark");
		const frame = renderPage(`<p>Plain</p>${PROBE}`);
		expect(frame.style.visibility).toBe("");
		expect(frame).toHaveClass("bg-white");
		expect(frame.style.colorScheme).toBe("light");
		await waitFor(() => expect(signals).toContain("load"));

		themeActions.setMode("light");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(signals.some((s) => s.startsWith("themed:"))).toBe(false);
	});
});
