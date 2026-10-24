import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentsQueryKey } from "../../hooks/useContents";
import { ENTRY_DRAG_TYPE } from "../../lib/entryDrag";
import type { Entry } from "../../types/contents";
import FileTree from "./FileTree";
import { useFileDrop } from "./useFileDrop";

const getFile = vi.fn();
const wsState = { actions: { getFile } };

vi.mock("../../lib/wsStore", () => ({
	useWSStore: Object.assign(
		(selector: (state: unknown) => unknown) => selector(wsState),
		{ getState: () => wsState },
	),
	isRPCTimeout: () => false,
}));

vi.mock("../../hooks/useFSWatch", () => ({ useFSWatch: () => {} }));

const onDrop = vi.fn();
const onEntryDragStart = vi.fn();
let scrollContainer: HTMLElement | null = null;
const NO_PATHS: readonly string[] = [];
const NOTHING_MOVING: ReadonlySet<string> = new Set();

/**
 * The tree wired to the real drag hook.
 *
 * The two halves are only correct together: the hook reads `data-entry-*` off
 * whatever the cursor is over, and the tree is the only thing that puts those
 * there. Testing either against a stand-in would let them drift apart.
 */
function Panel({
	onOpenMenu = vi.fn(),
	canDrag = true,
	movingPaths = NOTHING_MOVING,
}: {
	onOpenMenu?: (entry: Entry) => void;
	canDrag?: boolean;
	movingPaths?: ReadonlySet<string>;
}) {
	// What the tab keeps: which row's drag is this panel's own.
	const sourceRef = useRef<string | null>(null);
	const drop = useFileDrop({
		accepts: () => true,
		ownsEntryDrag: () => sourceRef.current !== null,
		onDrop,
		getScrollContainer: () => scrollContainer,
	});
	return (
		<div data-testid="panel" {...drop.dropProps}>
			<FileTree
				onSelectFile={vi.fn()}
				activeFilePath={null}
				expandSignal={0}
				watchEnabled={false}
				onOpenMenu={onOpenMenu}
				menuPath={null}
				dropTargetPath={drop.destPath}
				springOpenPath={drop.springOpenPath}
				forceOpenPaths={NO_PATHS}
				onEntryDragStart={
					canDrag
						? (entry, drag) => {
								sourceRef.current = entry.path;
								onEntryDragStart(entry, drag);
							}
						: undefined
				}
				dragSourcePath={null}
				movingPaths={movingPaths}
			/>
		</div>
	);
}

function entry(name: string, type: "file" | "dir", dir = ""): Entry {
	return { name, type, path: dir ? `${dir}/${name}` : name };
}

function renderTree(
	listings: Record<string, Entry[]>,
	onOpenMenu?: (entry: Entry) => void,
	panel: { canDrag?: boolean; movingPaths?: ReadonlySet<string> } = {},
) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	for (const [path, entries] of Object.entries(listings)) {
		queryClient.setQueryData(contentsQueryKey(path), entries);
	}
	return render(
		<QueryClientProvider client={queryClient}>
			<Panel onOpenMenu={onOpenMenu} {...panel} />
		</QueryClientProvider>,
	);
}

const FILE_DRAG = {
	types: ["Files"],
	dropEffect: "none",
	files: [],
	items: [] as unknown[],
};

/**
 * Fires one drag event carrying both a file and a cursor position.
 *
 * Not `fireEvent.dragOver`: jsdom implements no `DragEvent`, so that falls back
 * to a plain `Event` and quietly drops `clientY` — the one thing the edge
 * auto-scroll is made of. `MouseEvent` carries it, and React dispatches on the
 * type name rather than the constructor.
 */
function fireDrag(
	target: Element,
	type: string,
	clientY = 0,
	dataTransfer: unknown = FILE_DRAG,
) {
	const event = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		clientY,
	});
	Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
	fireEvent(target, event);
}

/** A row's drag as `dragstart` hands it over: empty, for the row to fill in. */
function entryDrag() {
	const data: Record<string, string> = {};
	return {
		types: [] as string[],
		effectAllowed: "uninitialized",
		dropEffect: "none",
		data,
		setData(type: string, value: string) {
			data[type] = value;
			this.types.push(type);
		},
	};
}

function dragOver(target: Element, clientY = 0) {
	fireDrag(target, "dragenter", clientY);
	fireDrag(target, "dragover", clientY);
}

function dropOn(target: Element) {
	dragOver(target);
	fireDrag(target, "drop");
}

/** The element carrying the row's highlight, now that the row is two nodes. */
function rowOf(button: HTMLElement): HTMLElement {
	const row = button.parentElement;
	if (!row) throw new Error("row button is not inside a row");
	return row;
}

function lastDestPath(): string {
	const calls = onDrop.mock.calls;
	return calls[calls.length - 1][0].destPath;
}

describe("FileTree as a drop target", () => {
	beforeEach(() => {
		onDrop.mockReset();
		getFile.mockReset();
		getFile.mockReturnValue(new Promise(() => {}));
		scrollContainer = null;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("takes a folder row as the destination", () => {
		renderTree({ "": [entry("src", "dir")] });

		dropOn(screen.getByRole("button", { name: "Expand folder: src" }));

		expect(lastDestPath()).toBe("src");
	});

	it("takes a file row as the folder holding it", () => {
		renderTree({ "": [entry("readme.md", "file")] });

		dropOn(screen.getByRole("button", { name: "Open file: readme.md" }));

		expect(lastDestPath()).toBe("");
	});

	it("takes the blank tree as the project root", () => {
		renderTree({ "": [entry("readme.md", "file")] });

		dropOn(screen.getByTestId("panel"));

		expect(lastDestPath()).toBe("");
	});

	it("marks the folder a drop would land in", () => {
		renderTree({ "": [entry("src", "dir")] });
		const button = screen.getByRole("button", { name: "Expand folder: src" });

		expect(rowOf(button)).not.toHaveClass("bg-th-accent/10");

		dragOver(button);

		// On the row rather than the button: the button stops short of the menu,
		// so a highlight there would leave a notch out of the drop target.
		expect(rowOf(button)).toHaveClass("bg-th-accent/10");
	});

	it("opens a closed folder held under the cursor, and then drops into it", () => {
		vi.useFakeTimers();
		renderTree({
			"": [entry("src", "dir")],
			src: [entry("main.tsx", "file", "src")],
		});

		dragOver(screen.getByRole("button", { name: "Expand folder: src" }));
		expect(screen.queryByText("main.tsx")).not.toBeInTheDocument();

		act(() => vi.advanceTimersByTime(700));

		const child = screen.getByRole("button", { name: "Open file: main.tsx" });
		dropOn(child);

		// The child was unreachable a moment ago: a drag cannot click a folder open.
		expect(lastDestPath()).toBe("src");
	});

	it("scrolls the tree while the cursor rests against its bottom edge", async () => {
		// jsdom has no layout, so everything the edge check reads is stated here:
		// a 1000px tree showing 200px of itself, laid out from y=0 to y=200.
		const scroller = document.createElement("div");
		Object.defineProperty(scroller, "scrollHeight", { value: 1000 });
		Object.defineProperty(scroller, "clientHeight", { value: 200 });
		// Shadows jsdom's accessor, which refuses to move without a scrolling box.
		Object.defineProperty(scroller, "scrollTop", { value: 0, writable: true });
		scroller.getBoundingClientRect = () =>
			({ top: 0, bottom: 200, height: 200 }) as DOMRect;
		scrollContainer = scroller;

		renderTree({ "": [entry("readme.md", "file")] });
		const row = screen.getByRole("button", { name: "Open file: readme.md" });

		dragOver(row, 190);

		// Without this a drag could only ever reach the folders already on screen.
		await waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(0));

		fireDrag(row, "dragover", 100);
		const stopped = scroller.scrollTop;
		await new Promise((resolve) => setTimeout(resolve, 60));

		// And away from the edge it has to stop, or the tree would run away from
		// under the cursor for the rest of the drag.
		expect(scroller.scrollTop).toBe(stopped);
	});

	it("takes the gap around a loading folder's contents as that folder", () => {
		vi.useFakeTimers();
		renderTree({ "": [entry("src", "dir")] });

		dragOver(screen.getByRole("button", { name: "Expand folder: src" }));
		act(() => vi.advanceTimersByTime(700));

		// Nowhere inside the panel is dead space: the spinner standing in for the
		// contents belongs to the folder it is loading.
		dropOn(screen.getByRole("status"));

		expect(lastDestPath()).toBe("src");
	});
});

describe("FileTree row actions", () => {
	beforeEach(() => {
		getFile.mockReset();
		getFile.mockReturnValue(new Promise(() => {}));
	});

	it("offers a menu on every row, files included", () => {
		renderTree({ "": [entry("src", "dir"), entry("readme.md", "file")] });

		expect(
			screen.getByRole("button", { name: "More actions for src" }),
		).toBeInTheDocument();
		// A file has a menu too: deleting is reachable from nowhere else.
		expect(
			screen.getByRole("button", { name: "More actions for readme.md" }),
		).toBeInTheDocument();
	});

	it("opens the menu without opening the folder it belongs to", () => {
		const onOpenMenu = vi.fn();
		renderTree({ "": [entry("src", "dir")] }, onOpenMenu);

		fireEvent.click(
			screen.getByRole("button", { name: "More actions for src" }),
		);

		expect(onOpenMenu).toHaveBeenCalledWith(
			expect.objectContaining({ path: "src" }),
		);
		// The button is a sibling of the row, not inside it: nested, this tap
		// would have toggled the folder on its way out.
		expect(
			screen.getByRole("button", { name: "Expand folder: src" }),
		).toHaveAttribute("aria-expanded", "false");
	});
});

describe("FileTree as a drag source", () => {
	beforeEach(() => {
		onDrop.mockReset();
		onEntryDragStart.mockReset();
		getFile.mockReset();
		getFile.mockReturnValue(new Promise(() => {}));
	});

	it("carries the entry as a move, and nothing a text field would take", () => {
		renderTree({ "": [entry("src", "dir")] });
		const row = rowOf(
			screen.getByRole("button", { name: "Expand folder: src" }),
		);
		const dataTransfer = entryDrag();

		expect(row).toHaveAttribute("draggable", "true");
		fireDrag(row, "dragstart", 0, dataTransfer);

		expect(dataTransfer.effectAllowed).toBe("move");
		// With `text/plain` a row let go over the chat composer would type its
		// path there.
		expect(dataTransfer.types).toEqual([ENTRY_DRAG_TYPE]);
		expect(JSON.parse(dataTransfer.data[ENTRY_DRAG_TYPE])).toEqual({
			path: "src",
			type: "dir",
		});
		expect(onEntryDragStart).toHaveBeenCalledWith(
			expect.objectContaining({ path: "src" }),
			expect.objectContaining({ wasExpanded: false, element: row }),
		);
	});

	it("drops a dragged row into the folder it is let go over", () => {
		renderTree({ "": [entry("src", "dir"), entry("readme.md", "file")] });
		const dataTransfer = entryDrag();
		fireDrag(
			rowOf(screen.getByRole("button", { name: "Open file: readme.md" })),
			"dragstart",
			0,
			dataTransfer,
		);

		const folder = screen.getByRole("button", { name: "Expand folder: src" });
		fireDrag(folder, "dragenter", 0, dataTransfer);
		fireDrag(folder, "dragover", 0, dataTransfer);
		expect(dataTransfer.dropEffect).toBe("move");
		expect(rowOf(folder)).toHaveClass("bg-th-accent/10");
		fireDrag(folder, "drop", 0, dataTransfer);

		expect(onDrop).toHaveBeenCalledWith({ kind: "entry", destPath: "src" });
	});

	it("ignores a row dragged in from another window", () => {
		renderTree({ "": [entry("src", "dir")] });
		// The type is there, but no row of this tree started the drag.
		const dataTransfer = { types: [ENTRY_DRAG_TYPE], dropEffect: "none" };
		const folder = screen.getByRole("button", { name: "Expand folder: src" });

		fireDrag(folder, "dragenter", 0, dataTransfer);
		fireDrag(folder, "dragover", 0, dataTransfer);
		fireDrag(folder, "drop", 0, dataTransfer);

		expect(rowOf(folder)).not.toHaveClass("bg-th-accent/10");
		expect(onDrop).not.toHaveBeenCalled();
	});

	it("offers no drag where the tab gives rows none", () => {
		renderTree({ "": [entry("src", "dir")] }, undefined, { canDrag: false });

		// A touch screen: a long press there is a scroll or a menu, not a drag.
		expect(
			rowOf(screen.getByRole("button", { name: "Expand folder: src" })),
		).not.toHaveAttribute("draggable");
	});

	it("dims a row whose move is in flight and drags nothing in it again", () => {
		vi.useFakeTimers();
		renderTree(
			{
				"": [entry("src", "dir"), entry("readme.md", "file")],
				src: [entry("main.tsx", "file", "src")],
			},
			undefined,
			{ movingPaths: new Set(["src"]) },
		);
		const row = rowOf(
			screen.getByRole("button", { name: "Expand folder: src" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Expand folder: src" }));

		expect(row).not.toHaveAttribute("draggable");
		expect(row.closest("[data-entry-path]")).toHaveClass("opacity-50");
		expect(
			rowOf(screen.getByRole("button", { name: "Open file: main.tsx" })),
		).not.toHaveAttribute("draggable");
		expect(
			rowOf(screen.getByRole("button", { name: "Open file: readme.md" })),
		).toHaveAttribute("draggable", "true");
		vi.useRealTimers();
	});
});

describe("FileTree forced open", () => {
	it("reopens a folder collapsed since, on a new request for the same path", async () => {
		getFile.mockReturnValue(new Promise(() => {}));
		const queryClient = new QueryClient();
		queryClient.setQueryData(contentsQueryKey(""), [entry("src", "dir")]);
		const tree = (forceOpenPaths: readonly string[]) => (
			<QueryClientProvider client={queryClient}>
				<FileTree
					onSelectFile={vi.fn()}
					activeFilePath={null}
					expandSignal={0}
					watchEnabled={false}
					onOpenMenu={vi.fn()}
					menuPath={null}
					dropTargetPath={null}
					springOpenPath={null}
					forceOpenPaths={forceOpenPaths}
					dragSourcePath={null}
					movingPaths={new Set()}
				/>
			</QueryClientProvider>
		);
		const { rerender } = render(tree(["src"]));
		const folder = () => screen.getByRole("button", { name: /folder: src/ });
		expect(folder()).toHaveAttribute("aria-expanded", "true");

		fireEvent.click(folder());
		expect(folder()).toHaveAttribute("aria-expanded", "false");

		// Created into, or moved into, a second time: the same path, asked again.
		rerender(tree(["src"]));
		expect(folder()).toHaveAttribute("aria-expanded", "true");
	});
});
