import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { act, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useBackToClose } from "./useBackToClose";

function Viewer({ onBack }: { onBack: () => void }) {
	useBackToClose(onBack);
	return <p>viewer</p>;
}

let setOpen: (open: boolean) => void = () => {};

function setup() {
	const onBack = vi.fn();
	function Root() {
		const [open, set] = useState(true);
		setOpen = set;
		return open ? (
			<Viewer
				onBack={() => {
					onBack();
					set(false);
				}}
			/>
		) : null;
	}
	const history = createMemoryHistory({ initialEntries: ["/chat"] });
	const router = createRouter({
		routeTree: createRootRoute({ component: Root }),
		history,
	});
	render(<RouterProvider router={router} />);
	return { history, onBack };
}

/** The viewer's entry is pushed a tick after it mounts. */
async function entryPushed(history: ReturnType<typeof createMemoryHistory>) {
	await waitFor(() =>
		expect(history.location.state).toHaveProperty("fullScreen"),
	);
}

describe("useBackToClose", () => {
	it("closes on Back, leaving the page where it was", async () => {
		const { history, onBack } = setup();
		await entryPushed(history);
		expect(history.location.pathname).toBe("/chat");

		act(() => history.back());
		expect(onBack).toHaveBeenCalledOnce();
		expect(history.location.pathname).toBe("/chat");
		expect(history.location.state).not.toHaveProperty("fullScreen");
	});

	it("takes its entry back when closed any other way", async () => {
		const { history, onBack } = setup();
		await entryPushed(history);

		act(() => setOpen(false));
		expect(history.location.state).not.toHaveProperty("fullScreen");
		expect(history.canGoBack()).toBe(false);
		expect(onBack).not.toHaveBeenCalled();
	});
});
