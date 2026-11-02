import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pageBridgeScript } from "./pageBridge";
import {
	BASE_ATTRIBUTE,
	type PageTheme,
	pageBaseCss,
	pageBaseStylesheet,
} from "./pageTheme";

// A real engine, because what the base stylesheet promises is the cascade's:
// that a layer and `:where()` put every rule of the agent's above it. The
// test document is both sides, as in `pageBridge.browser.test.ts`: the bridge
// runs in it with the test's own window as the app. The app's own stylesheet
// is in this document too and sets the root's `color-scheme` unlayered, so the
// scheme is read here from the stylesheet's text, not computed.

const LIGHT: PageTheme = {
	scheme: "light",
	vars: { "--pk-bg": "rgb(250, 250, 250)", "--pk-text": "rgb(10, 10, 10)" },
};
const DARK: PageTheme = {
	scheme: "dark",
	vars: {
		"--pk-bg": "rgb(20, 20, 20)",
		"--pk-text": "rgb(240, 240, 240)",
		"--pk-bg-secondary": "rgb(40, 40, 40)",
	},
};

let received: { type: string; scheme?: string }[] = [];
let page: HTMLElement;

function onMessage(event: MessageEvent) {
	const data: unknown = event.data;
	if (
		event.source === window &&
		data &&
		typeof data === "object" &&
		"type" in data &&
		typeof data.type === "string" &&
		data.type.startsWith("pockode:page-")
	) {
		received.push(data as { type: string });
	}
}

function base(): HTMLStyleElement {
	const found = document.querySelector<HTMLStyleElement>(
		`style[${BASE_ATTRIBUTE}]`,
	);
	if (!found) throw new Error("no base stylesheet");
	return found;
}

beforeAll(() => {
	window.addEventListener("message", onMessage);
	// As drawn: the bridge, then the base stylesheet, then the agent's page.
	const script = document.createElement("script");
	script.textContent = pageBridgeScript("window", {
		sends: false,
		themed: true,
	}).replace(/^<script>|<\/script>$/g, "");
	document.head.append(script);
	document.head.insertAdjacentHTML("beforeend", pageBaseStylesheet(LIGHT));
	page = document.createElement("div");
	document.body.append(page);
});

afterEach(() => {
	page.innerHTML = "";
	received = [];
});

describe("a page that follows the theme", () => {
	it("gets no send of its own", () => {
		expect("pockode" in window).toBe(false);
	});

	it("takes the variables, the scheme and the ground on its root", () => {
		const root = getComputedStyle(document.documentElement);
		expect(root.getPropertyValue("--pk-bg").trim()).toBe("rgb(250, 250, 250)");
		expect(root.color).toBe("rgb(10, 10, 10)");
	});

	it("loses every rule to the agent's, a root variable it overrides included", () => {
		page.innerHTML = `<style>
			button.mine { background: rgb(1, 2, 3); border-radius: 0 }
			:root { --pk-text: rgb(9, 8, 7) }
			@layer agent { input { background: rgb(4, 5, 6) } }
		</style><button class="mine">Mine</button><button>Base</button><input>`;
		const [mine, plain] = page.querySelectorAll("button");
		expect(getComputedStyle(mine).backgroundColor).toBe("rgb(1, 2, 3)");
		expect(getComputedStyle(mine).borderRadius).toBe("0px");
		expect(getComputedStyle(plain).borderRadius).toBe("6px");
		expect(getComputedStyle(document.documentElement).color).toBe(
			"rgb(9, 8, 7)",
		);
		// A later layer of the agent's is above the base's, named first.
		expect(
			getComputedStyle(page.querySelector("input") as HTMLElement)
				.backgroundColor,
		).toBe("rgb(4, 5, 6)");
	});

	it("rewrites the base stylesheet to a posted theme, the same text the app draws, and says so", async () => {
		const field = document.createElement("input");
		page.append(field);
		field.value = "typed";
		window.postMessage({ type: "pockode:page-theme", ...DARK }, "*");

		await vi.waitFor(() =>
			expect(received).toContainEqual({
				type: "pockode:page-themed",
				scheme: "dark",
			}),
		);
		expect(base().textContent).toBe(pageBaseCss(DARK));
		expect(base().getAttribute(BASE_ATTRIBUTE)).toBe("dark");
		expect(getComputedStyle(field).backgroundColor).toBe("rgb(40, 40, 40)");
		// Not redrawn: what was typed is still there.
		expect(field.value).toBe("typed");
		// Never an inline style, which would outrank the agent's own root.
		expect(document.documentElement.getAttribute("style")).toBeNull();
	});

	it("takes a theme only from the app's window", async () => {
		const other = document.createElement("iframe");
		other.srcdoc = `<script>parent.postMessage({type:"pockode:page-theme",scheme:"light",vars:{}},"*");parent.postMessage({signal:"posted"},"*");</script>`;
		const before = base().textContent;
		const posted = new Promise<void>((resolve) => {
			const done = (event: MessageEvent) => {
				if (event.data?.signal !== "posted") return;
				window.removeEventListener("message", done);
				resolve();
			};
			window.addEventListener("message", done);
		});
		document.body.append(other);
		await posted;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(base().textContent).toBe(before);
		expect(received).not.toContainEqual(
			expect.objectContaining({ type: "pockode:page-themed" }),
		);
		other.remove();
	});
});
