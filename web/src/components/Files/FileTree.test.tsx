import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentsQueryKey } from "../../hooks/useContents";
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
let scrollContainer: HTMLElement | null = null;

/**
 * The tree wired to the real drag hook.
 *
 * The two halves are only correct together: the hook reads `data-entry-*` off
 * whatever the cursor is over, and the tree is the only thing that puts those
 * there. Testing either against a stand-in would let them drift apart.
 */
function Panel() {
	const drop = useFileDrop({
		enabled: true,
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
				uploadDestPath=""
				onSelectDir={vi.fn()}
				dropTargetPath={drop.destPath}
				springOpenPath={drop.springOpenPath}
			/>
		</div>
	);
}

function entry(name: string, type: "file" | "dir", dir = ""): Entry {
	return { name, type, path: dir ? `${dir}/${name}` : name };
}

function renderTree(listings: Record<string, Entry[]>) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	for (const [path, entries] of Object.entries(listings)) {
		queryClient.setQueryData(contentsQueryKey(path), entries);
	}
	return render(
		<QueryClientProvider client={queryClient}>
			<Panel />
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
function fireDrag(target: Element, type: string, clientY = 0) {
	const event = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		clientY,
	});
	Object.defineProperty(event, "dataTransfer", { value: FILE_DRAG });
	fireEvent(target, event);
}

function dragOver(target: Element, clientY = 0) {
	fireDrag(target, "dragenter", clientY);
	fireDrag(target, "dragover", clientY);
}

function dropOn(target: Element) {
	dragOver(target);
	fireDrag(target, "drop");
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
		const row = screen.getByRole("button", { name: "Expand folder: src" });

		expect(row).not.toHaveClass("bg-th-accent/10");

		dragOver(row);

		expect(row).toHaveClass("bg-th-accent/10");
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
