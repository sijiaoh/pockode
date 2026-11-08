import {
	ConfirmDialog,
	LayerHistoryContext,
	Sheet,
	useCoverPage,
} from "@pockode/shared";
import {
	createBrowserHistory,
	createMemoryHistory,
	type HistoryState,
} from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { describe, expect, it } from "vitest";
import { layerHistoryFor, visitKeyOf } from "./layerHistory";

// The acceptance table of docs/project-ui.md §5.2, held against a memory
// history: the layers and the router's history wrapper are all that decide
// what history holds, and neither needs a router to do it.

type History = ReturnType<typeof createMemoryHistory>;

function setup(ui: (history: History) => ReactNode) {
	const history = createMemoryHistory({ initialEntries: ["/before", "/page"] });
	render(
		<LayerHistoryContext value={layerHistoryFor(history)}>
			{ui(history)}
		</LayerHistoryContext>,
	);
	return history;
}

const depth = (history: { location: { state: unknown } }) =>
	(history.location.state as { pockodeLayers?: string[] }).pockodeLayers
		?.length ?? 0;
const index = (history: History) => history.location.state.__TSR_index;

/** A layer's entry is pushed a tick after it opens. */
async function layersUp(history: History, count = 1) {
	await waitFor(() => expect(depth(history)).toBe(count));
}

/** Every layer entry gone back over: the page's own entry is current. */
async function onPage(history: History) {
	await waitFor(() => {
		expect(depth(history)).toBe(0);
		expect(index(history)).toBe(1);
	});
}

function back(history: History) {
	act(() => history.back());
}

function SheetHost({
	children,
	dismissible,
	footer,
}: {
	children?: (close: () => void) => ReactNode;
	dismissible?: boolean;
	footer?: ReactNode;
}) {
	const [open, setOpen] = useState(true);
	const close = () => setOpen(false);
	return open ? (
		<Sheet
			title="Sheet"
			onClose={close}
			dismissible={dismissible}
			footer={footer}
		>
			{children?.(close)}
		</Sheet>
	) : (
		<p>no sheet</p>
	);
}

describe("Back closes the topmost layer", () => {
	it("closes a sheet on Back and leaves the page where it was", async () => {
		const history = setup(() => <SheetHost />);
		await layersUp(history);

		back(history);
		expect(screen.getByText("no sheet")).toBeInTheDocument();
		expect(history.location.pathname).toBe("/page");
		await onPage(history);

		back(history);
		expect(history.location.pathname).toBe("/before");
	});

	it("leaves no entry behind a sheet closed by its own ✕", async () => {
		const user = userEvent.setup();
		const history = setup(() => <SheetHost />);
		await layersUp(history);

		await user.click(screen.getByRole("button", { name: "Close" }));
		await onPage(history);

		back(history);
		expect(history.location.pathname).toBe("/before");
	});

	it("is one page visit under the sheet and on the page alike", async () => {
		const history = setup(() => <SheetHost />);
		const page = visitKeyOf(history.location);
		await layersUp(history);

		expect(visitKeyOf(history.location)).toBe(page);
	});

	it("closes a dialog over a sheet first, then the sheet, then leaves", async () => {
		const user = userEvent.setup();
		const history = setup(() => <SheetHost>{() => <Asker />}</SheetHost>);
		await layersUp(history);
		await user.click(screen.getByRole("button", { name: "Ask" }));
		await layersUp(history, 2);

		back(history);
		expect(screen.queryByText("Sure?")).not.toBeInTheDocument();
		expect(screen.getByText("Sheet")).toBeInTheDocument();

		back(history);
		expect(screen.getByText("no sheet")).toBeInTheDocument();

		back(history);
		expect(history.location.pathname).toBe("/before");
	});

	it("holds a navigation made from a sheet until the sheet's entry is gone", async () => {
		const user = userEvent.setup();
		const history = setup((h) => (
			<SheetHost>
				{(close) => (
					<button
						type="button"
						onClick={() => {
							close();
							h.push("/new");
						}}
					>
						Open
					</button>
				)}
			</SheetHost>
		));
		await layersUp(history);

		await user.click(screen.getByRole("button", { name: "Open" }));
		await waitFor(() => expect(history.location.pathname).toBe("/new"));
		expect(index(history)).toBe(2);

		back(history);
		expect(history.location.pathname).toBe("/page");
		expect(depth(history)).toBe(0);
		expect(screen.getByText("no sheet")).toBeInTheDocument();
	});

	it("makes no step of a navigation from a sheet to the page under it", async () => {
		const user = userEvent.setup();
		const history = setup((h) => (
			<SheetHost>
				{() => (
					<button type="button" onClick={() => h.push("/page")}>
						Same
					</button>
				)}
			</SheetHost>
		));
		await layersUp(history);

		await user.click(screen.getByRole("button", { name: "Same" }));

		await onPage(history);
		expect(screen.getByText("no sheet")).toBeInTheDocument();
	});

	it("keeps a setting changed from inside a sheet the sheet's Back took away", async () => {
		const user = userEvent.setup();
		const history = setup((h) => (
			<SheetHost>
				{() => (
					<button type="button" onClick={() => h.replace("/page?scope=all")}>
						All
					</button>
				)}
			</SheetHost>
		));
		await layersUp(history);

		await user.click(screen.getByRole("button", { name: "All" }));
		expect(history.location.href).toBe("/page?scope=all");
		expect(depth(history)).toBe(1);

		back(history);
		await waitFor(() => expect(history.location.href).toBe("/page?scope=all"));
		expect(depth(history)).toBe(0);

		back(history);
		expect(history.location.pathname).toBe("/before");
	});

	it("refuses Back while the sheet refuses to close, and not after", async () => {
		function Busy() {
			const [busy, setBusy] = useState(true);
			return (
				<SheetHost
					dismissible={!busy}
					footer={
						<button type="button" onClick={() => setBusy(false)}>
							Done
						</button>
					}
				/>
			);
		}
		const user = userEvent.setup();
		const history = setup(() => <Busy />);
		await layersUp(history);

		back(history);
		expect(screen.getByText("Sheet")).toBeInTheDocument();
		await layersUp(history);

		back(history);
		expect(screen.getByText("Sheet")).toBeInTheDocument();
		await layersUp(history);

		await user.click(screen.getByRole("button", { name: "Done" }));
		back(history);
		expect(screen.getByText("no sheet")).toBeInTheDocument();
		await onPage(history);
	});

	it("holds one entry for a menu sheet replaced by its confirmation", async () => {
		function Menu() {
			const [step, setStep] = useState<"menu" | "confirm" | "none">("menu");
			if (step === "menu") {
				return (
					<Sheet title="Menu" onClose={() => setStep("none")}>
						<button type="button" onClick={() => setStep("confirm")}>
							Delete
						</button>
					</Sheet>
				);
			}
			if (step === "confirm") {
				return (
					<ConfirmDialog
						title="Sure?"
						message="Really."
						onConfirm={() => setStep("none")}
						onCancel={() => setStep("none")}
					/>
				);
			}
			return <p>no sheet</p>;
		}
		const user = userEvent.setup();
		const history = setup(() => <Menu />);
		await layersUp(history);
		const menuEntry = history.location.state.__TSR_key;

		await user.click(screen.getByRole("button", { name: "Delete" }));
		// The menu's entry gone back over, and the confirmation's pushed in its
		// place: one layer over the page.
		await waitFor(() =>
			expect(history.location.state.__TSR_key).not.toBe(menuEntry),
		);
		await layersUp(history);
		expect(index(history)).toBe(2);
		expect(screen.getByText("Sure?")).toBeInTheDocument();

		back(history);
		expect(screen.getByText("no sheet")).toBeInTheDocument();
		expect(index(history)).toBe(1);
		expect(depth(history)).toBe(0);
	});

	it("leaves a layer up when the one under it closes", async () => {
		// A sibling ahead of the sheet, so that it registers — and pushes — first.
		function Lower() {
			const [lower, setLower] = useState(true);
			useCoverPage(lower, { onBack: () => setLower(false) });
			return (
				<button type="button" onClick={() => setLower(false)}>
					Close lower
				</button>
			);
		}
		function Two() {
			const [upper, setUpper] = useState(true);
			return (
				<>
					<Lower />
					{upper ? (
						<Sheet title="Upper" onClose={() => setUpper(false)}>
							upper
						</Sheet>
					) : (
						<p>no upper</p>
					)}
				</>
			);
		}
		const history = setup(() => <Two />);
		await layersUp(history, 2);

		// Behind the sheet's backdrop: reached as a resize or the app would.
		act(() =>
			screen.getByRole("button", { name: "Close lower", hidden: true }).click(),
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(screen.getByText("Upper")).toBeInTheDocument();
		expect(depth(history)).toBe(2);

		back(history);
		expect(screen.getByText("no upper")).toBeInTheDocument();
		await onPage(history);
	});

	it("keeps a setting changed from inside a sheet closed by its ✕", async () => {
		const user = userEvent.setup();
		const history = setup((h) => (
			<SheetHost>
				{() => (
					<button type="button" onClick={() => h.replace("/page?scope=all")}>
						All
					</button>
				)}
			</SheetHost>
		));
		await layersUp(history);

		await user.click(screen.getByRole("button", { name: "All" }));
		await user.click(screen.getByRole("button", { name: "Close" }));

		await onPage(history);
		await waitFor(() => expect(history.location.href).toBe("/page?scope=all"));
	});

	it("lands a navigation a running confirmation makes, without re-pushing its entry", async () => {
		const history = setup((h) => <Navigating history={h} />);
		await layersUp(history);
		const user = userEvent.setup();

		await user.click(screen.getByRole("button", { name: "Go" }));
		await waitFor(() => expect(history.location.pathname).toBe("/new"));
		expect(screen.getByText("no dialog")).toBeInTheDocument();
		expect(index(history)).toBe(2);

		back(history);
		expect(history.location.pathname).toBe("/page");
		expect(depth(history)).toBe(0);
	});

	it("reopens nothing on Forward after a Back closed the sheet", async () => {
		const history = setup(() => <SheetHost />);
		await layersUp(history);
		back(history);
		await onPage(history);

		act(() => history.forward());
		await onPage(history);
		expect(screen.getByText("no sheet")).toBeInTheDocument();
		expect(history.location.pathname).toBe("/page");
	});

	it("closes a panel that locks nothing — a dropdown — on Back", async () => {
		function Dropdown() {
			const [open, setOpen] = useState(true);
			useCoverPage(open, { onBack: () => setOpen(false) });
			return <p>{open ? "dropdown" : "no dropdown"}</p>;
		}
		const history = setup(() => <Dropdown />);
		await layersUp(history);

		back(history);
		expect(screen.getByText("no dropdown")).toBeInTheDocument();
		expect(history.location.pathname).toBe("/page");
	});
});

describe("a reload with a layer up", () => {
	it("keeps the entry's key on the window's history, which the trail reads", () => {
		window.history.pushState(
			{
				key: "reloaded",
				__TSR_key: "reloaded",
				__TSR_index: 1,
				pockodeLayers: ["old-1"],
				pockodePage: "gone",
			},
			"",
			"/page",
		);
		const history = createBrowserHistory();

		layerHistoryFor(history);

		expect(depth(history)).toBe(0);
		expect(history.location.state.__TSR_key).toBe("reloaded");
		history.destroy();
	});

	it("strips the layer's marker and stays where it is", () => {
		const history = createMemoryHistory({ initialEntries: ["/page"] });
		history.push("/page", {
			pockodeLayers: ["old-1"],
			pockodePage: "gone",
		} as unknown as HistoryState);

		layerHistoryFor(history);

		expect(depth(history)).toBe(0);
		expect(history.location.pathname).toBe("/page");
		back(history);
		expect(history.location.pathname).toBe("/page");
	});
});

function Asker() {
	const [asking, setAsking] = useState(false);
	return asking ? (
		<ConfirmDialog
			title="Sure?"
			message="Really."
			onConfirm={() => setAsking(false)}
			onCancel={() => setAsking(false)}
		/>
	) : (
		<button type="button" onClick={() => setAsking(true)}>
			Ask
		</button>
	);
}

/** A confirmation whose action navigates and is still running when it does. */
function Navigating({ history }: { history: History }) {
	const [open, setOpen] = useState(true);
	return open ? (
		<ConfirmDialog
			title="Go?"
			message="Leaves."
			confirmLabel="Go"
			onConfirm={() => {
				history.push("/new");
				return new Promise(() => {});
			}}
			onCancel={() => setOpen(false)}
		/>
	) : (
		<p>no dialog</p>
	);
}
