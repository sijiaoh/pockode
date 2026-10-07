import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type DroppedFiles,
	readPasted,
	useFileDragZone,
} from "./useFileDragZone";

function Zone({
	enabled = true,
	ownDomOnly = false,
	onDrop = () => {},
}: {
	enabled?: boolean;
	ownDomOnly?: boolean;
	onDrop?: (dropped: DroppedFiles) => void;
}) {
	const zone = useFileDragZone({
		enabled,
		onDrop: (dropped) => onDrop(dropped),
		ownDomOnly,
	});
	return (
		<div data-testid="zone" {...zone.dropProps}>
			<span>inside</span>
			<span>also inside</span>
			{zone.isDragging && <span>dragging</span>}
			{/* A sheet raised from inside the zone, as `Sheet` is. */}
			{createPortal(<div>in a portal</div>, document.body)}
		</div>
	);
}

/** One dropped entry, as `DataTransferItem` describes it. */
function item(file: File, isDirectory = false) {
	return {
		kind: "file",
		getAsFile: () => file,
		webkitGetAsEntry: () => ({ isDirectory }),
	};
}

/**
 * jsdom has no `DragEvent` or `DataTransfer`; this is the shape the handlers
 * read, on an event React dispatches by its type name. `dropEffect` starts
 * unset, so an assertion on it reads what the zone wrote.
 */
function fireDrag(
	target: Element,
	type: string,
	{
		items = [],
		types = ["Files"],
		relatedTarget = null,
	}: {
		items?: ReturnType<typeof item>[];
		types?: string[];
		/** For a leave: where the cursor went; null is out of the window. */
		relatedTarget?: Element | null;
	} = {},
) {
	const dataTransfer = { types, dropEffect: "", files: [], items };
	const event = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		relatedTarget,
	});
	Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
	fireEvent(target, event);
	return { event, dataTransfer };
}

describe("useFileDragZone", () => {
	it("claims a file drag and hands over the files, folders set apart", () => {
		const onDrop = vi.fn();
		render(<Zone onDrop={onDrop} />);
		const target = screen.getByText("inside");
		const a = new File(["a"], "a.txt");

		fireDrag(target, "dragenter");
		const over = fireDrag(target, "dragover");
		expect(over.dataTransfer.dropEffect).toBe("copy");
		expect(screen.getByText("dragging")).toBeInTheDocument();

		const drop = fireDrag(target, "drop", {
			items: [item(a), item(new File([], "src"), true)],
		});
		expect(drop.event.defaultPrevented).toBe(true);
		expect(onDrop).toHaveBeenCalledWith({ files: [a], hadFolder: true });
		expect(screen.queryByText("dragging")).not.toBeInTheDocument();
	});

	it("tracks a refused drag but hands nothing over", () => {
		const onDrop = vi.fn();
		render(<Zone enabled={false} onDrop={onDrop} />);
		const target = screen.getByText("inside");

		fireDrag(target, "dragenter");
		const over = fireDrag(target, "dragover");
		expect(over.dataTransfer.dropEffect).toBe("none");
		expect(screen.getByText("dragging")).toBeInTheDocument();

		const drop = fireDrag(target, "drop", {
			items: [item(new File(["a"], "a.txt"))],
		});
		// Still prevented, or the browser would open the file in the tab.
		expect(drop.event.defaultPrevented).toBe(true);
		expect(onDrop).not.toHaveBeenCalled();
	});

	it("stays up while the cursor crosses children, and goes when it leaves", () => {
		render(<Zone />);
		const zone = screen.getByTestId("zone");
		const child = screen.getByText("inside");

		// The browser enters the new target before leaving the old one.
		fireDrag(zone, "dragenter");
		fireDrag(child, "dragenter");
		fireDrag(zone, "dragleave", { relatedTarget: child });
		expect(screen.getByText("dragging")).toBeInTheDocument();

		fireDrag(child, "dragleave", { relatedTarget: document.body });
		expect(screen.queryByText("dragging")).not.toBeInTheDocument();
	});

	it("leaves drags that carry no files alone", () => {
		render(<Zone />);
		const over = fireDrag(screen.getByText("inside"), "dragover", {
			types: ["text/plain"],
		});
		expect(over.event.defaultPrevented).toBe(false);
		expect(screen.queryByText("dragging")).not.toBeInTheDocument();
	});

	// A portal's events travel the React tree, so the zone hears a drag over a
	// sheet it raised — which would put files behind the sheet.
	it("ignores drags over its portals when it owns only its DOM", () => {
		const onDrop = vi.fn();
		render(<Zone ownDomOnly onDrop={onDrop} />);
		const portalled = screen.getByText("in a portal");

		fireDrag(portalled, "dragenter");
		const over = fireDrag(portalled, "dragover");
		fireDrag(portalled, "drop", { items: [item(new File(["a"], "a.txt"))] });

		expect(over.event.defaultPrevented).toBe(false);
		expect(screen.queryByText("dragging")).not.toBeInTheDocument();
		expect(onDrop).not.toHaveBeenCalled();
	});

	it("is left by a drag moving onto one of its portals", () => {
		render(<Zone ownDomOnly />);
		const zone = screen.getByTestId("zone");

		const portalled = screen.getByText("in a portal");

		fireDrag(zone, "dragenter");
		fireDrag(portalled, "dragenter");
		fireDrag(zone, "dragleave", { relatedTarget: portalled });

		expect(screen.queryByText("dragging")).not.toBeInTheDocument();
	});

	// An element removed from the page with the cursor over it never delivers
	// its `dragleave` — a streaming transcript does this all the time — so the
	// count is left one too high.
	describe("with a leave gone missing", () => {
		afterEach(() => vi.useRealTimers());

		/** Enters two children, then takes the second one's leave away. */
		const enterAndLoseALeave = () => {
			const zone = screen.getByTestId("zone");
			const first = screen.getByText("inside");
			fireDrag(zone, "dragenter");
			fireDrag(first, "dragenter");
			fireDrag(screen.getByText("also inside"), "dragenter");
			fireDrag(first, "dragleave", { relatedTarget: zone });
			return zone;
		};

		it("believes a leave that says it went outside", () => {
			render(<Zone ownDomOnly />);
			const zone = enterAndLoseALeave();

			fireDrag(zone, "dragleave", { relatedTarget: document.body });

			expect(screen.queryByText("dragging")).not.toBeInTheDocument();
		});

		it("lets go of a drag that left for nowhere and never came back", () => {
			vi.useFakeTimers();
			render(<Zone />);
			const zone = enterAndLoseALeave();

			fireDrag(zone, "dragleave");
			expect(screen.getByText("dragging")).toBeInTheDocument();

			act(() => vi.advanceTimersByTime(1000));
			expect(screen.queryByText("dragging")).not.toBeInTheDocument();
		});

		it("keeps a drag that left for nowhere but is still over the zone", () => {
			vi.useFakeTimers();
			render(<Zone />);
			const zone = enterAndLoseALeave();

			fireDrag(zone, "dragleave");
			act(() => vi.advanceTimersByTime(500));
			fireDrag(zone, "dragover");
			act(() => vi.advanceTimersByTime(1000));

			expect(screen.getByText("dragging")).toBeInTheDocument();
		});
	});
});

describe("readPasted", () => {
	const clipboard = (text: string, files: (File | ReturnType<typeof item>)[]) =>
		({
			getData: (type: string) => (type === "text/plain" ? text : ""),
			files: [],
			items: files.map((file) => (file instanceof File ? item(file) : file)),
		}) as unknown as DataTransfer;

	const shot = new File(["s"], "my shot.png");
	const notes = new File(["n"], "notes.txt");

	it("takes a clipboard that holds only files", () => {
		expect(readPasted(clipboard("", [shot]))).toEqual({
			files: [shot],
			hadFolder: false,
		});
	});

	it("leaves a clipboard with no file to the browser", () => {
		expect(readPasted(clipboard("hello", []))).toBeNull();
		expect(readPasted(clipboard("", []))).toBeNull();
	});

	// What file managers put beside the files they copy.
	it.each([
		["Finder's names", "my shot.png\rnotes.txt"],
		["GNOME Files' paths", "/home/u/my shot.png\n/home/u/notes.txt\n"],
		[
			"Dolphin's URIs",
			"file:///home/u/my%20shot.png\r\nfile:///home/u/notes.txt",
		],
		["a Windows path", "C:\\Users\\u\\my shot.png\nnotes.txt"],
	])("takes the files over text that is only %s", (_, text) => {
		expect(readPasted(clipboard(text, [shot, notes]))?.files).toEqual([
			shot,
			notes,
		]);
	});

	it("counts a folder's name as carried, and still refuses the folder", () => {
		const src = item(new File([], "src"), true);
		expect(
			readPasted(clipboard("/home/u/notes.txt\n/home/u/src/", [notes, src])),
		).toEqual({ files: [notes], hadFolder: true });
	});

	it.each([
		// A spreadsheet or a web page with its rendered picture.
		["text beside a picture", "a\tb\n1\t2", [new File(["i"], "image.png")]],
		// A browser that hands over Finder's icon in place of the file.
		[
			"a name the file does not have",
			"report.pdf",
			[new File(["i"], "image.png")],
		],
		// Both end in the carried file's name; only a local path is the file.
		["a web address", "https://example.com/notes.txt", [notes]],
		["a relative path", "docs/notes.txt", [notes]],
		["a name among other text", "my shot.png\nlooks good", [shot]],
	])("leaves %s to the browser", (_, text, files) => {
		expect(readPasted(clipboard(text, files))).toBeNull();
	});
});
