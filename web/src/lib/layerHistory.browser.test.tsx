import { LayerHistoryContext, Sheet } from "@pockode/shared";
import { createBrowserHistory } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { layerHistoryFor } from "./layerHistory";

// The window's own history, where a traversal is reported only once the
// browser's `popstate` arrives and the router writes its pushes a microtask
// late — neither of which a memory history (layerHistory.test.tsx) does.

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(
	onOpen?: (history: ReturnType<typeof createBrowserHistory>) => void,
) {
	// As the router writes them, so that it keeps the tags.
	const entry = (tag: string, index: number) => ({
		tag,
		key: tag,
		__TSR_key: tag,
		__TSR_index: index,
	});
	window.history.pushState(entry("before", 0), "", "/before");
	window.history.pushState(entry("page", 1), "", "/page");
	const history = createBrowserHistory();
	cleanups.push(() => history.destroy());
	const layers = layerHistoryFor(history);

	function Host() {
		const [open, setOpen] = useState(true);
		return open ? (
			<Sheet title="Sheet" onClose={() => setOpen(false)}>
				{onOpen && (
					<button
						type="button"
						onClick={() => {
							setOpen(false);
							onOpen(history);
						}}
					>
						Open
					</button>
				)}
			</Sheet>
		) : (
			<p>no sheet</p>
		);
	}
	render(
		<LayerHistoryContext value={layers}>
			<Host />
		</LayerHistoryContext>,
	);
	return history;
}

const layersOf = (state: unknown) =>
	(state as { pockodeLayers?: unknown[] } | null)?.pockodeLayers ?? [];
const layered = () => layersOf(window.history.state).length > 0;

describe("a layer's entry on the window's history", () => {
	it("closes the sheet on Back, and the next Back leaves the page", async () => {
		setup();
		await expect.poll(layered).toBe(true);

		window.history.back();
		expect(await screen.findByText("no sheet")).toBeInTheDocument();
		await expect.poll(() => location.pathname).toBe("/page");
		expect(layered()).toBe(false);

		window.history.back();
		await expect.poll(() => location.pathname).toBe("/before");
	});

	it("takes the entry back when the sheet is closed by ✕", async () => {
		setup();
		await expect.poll(layered).toBe(true);

		await userEvent.click(screen.getByRole("button", { name: "Close" }));
		await expect.poll(layered).toBe(false);
		expect(location.pathname).toBe("/page");

		window.history.back();
		await expect.poll(() => location.pathname).toBe("/before");
	});

	it("makes a navigation from the sheet from the page's own entry", async () => {
		setup((history) => history.push("/new"));
		await expect.poll(layered).toBe(true);

		await userEvent.click(screen.getByRole("button", { name: "Open" }));
		await expect.poll(() => location.pathname).toBe("/new");

		window.history.back();
		await expect.poll(() => location.pathname).toBe("/page");
		expect(layered()).toBe(false);
		expect(window.history.state?.tag).toBe("page");
	});

	it("reopens nothing on Forward, and goes back off the closed sheet's entry", async () => {
		setup();
		await expect.poll(layered).toBe(true);
		window.history.back();
		await screen.findByText("no sheet");
		await expect.poll(layered).toBe(false);

		// Each landing is recorded as it happens: the layers go back off the
		// closed sheet's entry as soon as Forward lands on it, a millisecond or
		// two later — too soon for a poll of the current entry ever to see it.
		const arrivals: unknown[] = [];
		const hear = (event: PopStateEvent) => arrivals.push(event.state);
		window.addEventListener("popstate", hear);
		cleanups.push(() => window.removeEventListener("popstate", hear));

		window.history.forward();
		await expect
			.poll(() => arrivals.map((state) => layersOf(state).length > 0))
			.toEqual([true, false]);
		expect(layered()).toBe(false);
		expect(window.history.state?.tag).toBe("page");
		expect(screen.getByText("no sheet")).toBeInTheDocument();
		expect(location.pathname).toBe("/page");
	});
});
