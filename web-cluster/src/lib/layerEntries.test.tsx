import {
	createLayerHistory,
	LayerHistoryContext,
	Sheet,
} from "@pockode/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { windowLayerEntries } from "./layerEntries";

// One for the file, as the app has one for the window: every instance hears
// every `popstate`, and one left from an earlier test would take the current
// test's entries for dead ones and go back over them.
const entries = windowLayerEntries();
const layers = createLayerHistory(entries);

function setup() {
	function Host() {
		const [open, setOpen] = useState(true);
		return open ? (
			<Sheet title="Node" onClose={() => setOpen(false)}>
				body
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
	return entries;
}

describe("windowLayerEntries", () => {
	it("gives a sheet an entry that Back closes it by", async () => {
		const entries = setup();
		const start = entries.index() ?? 0;
		await waitFor(() => expect(entries.layers()).toHaveLength(1));

		window.history.back();

		expect(await screen.findByText("no sheet")).toBeInTheDocument();
		expect(entries.layers()).toHaveLength(0);
		expect(entries.index()).toBe(start);
	});

	it("takes the entry back when the sheet is closed by its ✕", async () => {
		const user = userEvent.setup();
		const entries = setup();
		const start = entries.index() ?? 0;
		await waitFor(() => expect(entries.layers()).toHaveLength(1));

		await user.click(screen.getByRole("button", { name: "Close" }));

		await waitFor(() => expect(entries.index()).toBe(start));
		expect(entries.layers()).toHaveLength(0);
	});

	it("makes an entry left by a reload under a sheet the page's again", () => {
		window.history.pushState({ pockodeIndex: 3, pockodeLayers: ["old"] }, "");

		const entries = windowLayerEntries();

		expect(entries.layers()).toHaveLength(0);
		expect(entries.index()).toBe(3);
	});
});
