import {
	createBrowserHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWSStore } from "../lib/wsStore";
import { useDocumentTitle } from "./useDocumentTitle";

function Root() {
	useDocumentTitle();
	return null;
}

type History = ReturnType<typeof createBrowserHistory>;

const TITLE = "demo | Pockode";

const nativeTitle = Object.getOwnPropertyDescriptor(
	Document.prototype,
	"title",
);

/** Every title assigned, with the URL the browser showed at that moment. */
let assigned: { title: string; url: string }[];

function setup() {
	const history = createBrowserHistory();
	const router = createRouter({
		routeTree: createRootRoute({ component: Root }),
		history,
	});
	render(<RouterProvider router={router} />);
	return history;
}

/** What the tab shows: the title with the invisible marker drawn as nothing. */
function visibleTitle() {
	return document.title.replaceAll("\u200B", "");
}

async function titled(projectTitle = "demo") {
	useWSStore.setState({ projectTitle });
	const history = setup();
	await waitFor(() => expect(assigned.length).toBeGreaterThan(0));
	return history;
}

/** Navigates and waits for the title assignment that navigation causes. */
async function navigateAndWait(navigate: () => void) {
	const count = assigned.length;
	act(navigate);
	await waitFor(() => expect(assigned.length).toBeGreaterThan(count));
}

describe("useDocumentTitle", () => {
	beforeEach(() => {
		window.history.replaceState(null, "", "/");
		document.title = "";
		assigned = [];
		Object.defineProperty(document, "title", {
			configurable: true,
			get: () => nativeTitle?.get?.call(document),
			set: (title: string) => {
				assigned.push({ title, url: window.location.pathname });
				nativeTitle?.set?.call(document, title);
			},
		});
	});
	afterEach(() => {
		Reflect.deleteProperty(document, "title");
		useWSStore.setState({ projectTitle: "" });
	});

	it("titles the tab once the project title is known", async () => {
		setup();

		act(() => useWSStore.setState({ projectTitle: "demo" }));
		await waitFor(() => expect(visibleTitle()).toBe(TITLE));
	});

	// Firefox for Android shows a title again only when it receives one that
	// differs from the last, so each navigation must leave a different string
	// that still reads the same.
	it.each([
		["push", (h: History) => h.push("/a")],
		["replace", (h: History) => h.replace("/b")],
		[
			"push of the same URL with new state",
			(h: History) => h.push("/", { fullScreen: true }),
		],
	])("assigns a new title that reads the same after a %s", async (_, navigate) => {
		const history = await titled();
		const before = document.title;

		await navigateAndWait(() => navigate(history));
		expect(document.title).not.toBe(before);
		expect(visibleTitle()).toBe(TITLE);
	});

	it("assigns a new title that reads the same after going back", async () => {
		const history = await titled();
		await navigateAndWait(() => history.push("/a"));
		const before = document.title;

		await navigateAndWait(() => history.back());
		expect(window.location.pathname).toBe("/");
		expect(document.title).not.toBe(before);
		expect(visibleTitle()).toBe(TITLE);
	});

	it("keeps changing the title across consecutive navigations", async () => {
		const history = await titled();

		for (const path of ["/a", "/b", "/c"]) {
			const before = document.title;
			await navigateAndWait(() => history.push(path));
			expect(document.title).not.toBe(before);
			expect(visibleTitle()).toBe(TITLE);
		}
	});

	// The title getter collapses whitespace, so what reads back is not the
	// string that was assigned.
	it("keeps changing the title when the project name has runs of spaces", async () => {
		const history = await titled(" two  spaces ");

		for (const path of ["/a", "/b"]) {
			const before = document.title;
			await navigateAndWait(() => history.push(path));
			expect(document.title).not.toBe(before);
		}
	});

	// A title assigned before the router writes the URL would be blanked by
	// the URL change that follows it.
	it("assigns the title only after the URL has changed", async () => {
		const history = await titled();

		await navigateAndWait(() => history.push("/a"));
		expect(assigned.at(-1)?.url).toBe("/a");
	});

	it("leaves the title alone while no project is connected", async () => {
		document.title = "previous | Pockode";
		assigned = [];
		const history = setup();
		act(() => history.push("/a"));
		await waitFor(() => expect(window.location.pathname).toBe("/a"));
		await new Promise((resolve) => setTimeout(resolve));
		expect(assigned).toEqual([]);
	});
});
