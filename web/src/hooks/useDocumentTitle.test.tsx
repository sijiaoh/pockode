import {
	createMemoryHistory,
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

type History = ReturnType<typeof createMemoryHistory>;

function setup() {
	const history = createMemoryHistory({ initialEntries: ["/"] });
	const router = createRouter({
		routeTree: createRootRoute({ component: Root }),
		history,
	});
	render(<RouterProvider router={router} />);
	return history;
}

/**
 * Stands in for Firefox for Android, which clears the tab title on every URL
 * change: the test clears it, and only a fresh assignment brings it back.
 */
function browserDropsTitle() {
	document.title = "";
}

describe("useDocumentTitle", () => {
	beforeEach(() => {
		document.title = "";
	});
	afterEach(() => {
		useWSStore.setState({ projectTitle: "" });
	});

	it("titles the tab once the project title is known", async () => {
		setup();

		act(() => useWSStore.setState({ projectTitle: "demo" }));
		await waitFor(() => expect(document.title).toBe("demo | Pockode"));
	});

	it.each([
		["push", (h: History) => h.push("/a")],
		["replace", (h: History) => h.replace("/b")],
		[
			"push of the same URL with new state",
			(h: History) => h.push("/", { fullScreen: true }),
		],
	])("assigns the title again after a %s", async (_, navigate) => {
		useWSStore.setState({ projectTitle: "demo" });
		const history = setup();
		await waitFor(() => expect(document.title).toBe("demo | Pockode"));

		browserDropsTitle();
		act(() => navigate(history));
		await waitFor(() => expect(document.title).toBe("demo | Pockode"));
	});

	it("assigns the title again after going back", async () => {
		useWSStore.setState({ projectTitle: "demo" });
		const history = setup();
		act(() => history.push("/a"));
		await waitFor(() => expect(history.location.pathname).toBe("/a"));
		await waitFor(() => expect(document.title).toBe("demo | Pockode"));

		browserDropsTitle();
		act(() => history.back());
		await waitFor(() => expect(document.title).toBe("demo | Pockode"));
		expect(history.location.pathname).toBe("/");
	});

	it("leaves the title alone while no project is connected", async () => {
		document.title = "previous | Pockode";
		const history = setup();
		act(() => history.push("/a"));
		await waitFor(() => expect(history.location.pathname).toBe("/a"));
		expect(document.title).toBe("previous | Pockode");
	});
});
