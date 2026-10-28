import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitSegment } from "../../types/overlay";
import GitWorkspace, { type GitLayer } from "./GitWorkspace";

// What jsdom cannot say: how wide the list column is drawn at `expanded`,
// measured against the row it shares with the detail column — its default
// relative to that row, a drag moving its edge, the limits it is held to, and
// one width across every segment.

vi.mock("@pockode/shared", async (importOriginal) => ({
	...(await importOriginal<typeof import("@pockode/shared")>()),
	useIsExpanded: () => true,
}));
vi.mock("../../hooks/useOpenSessionUnread", () => ({
	useOpenSessionUnread: () => false,
}));
vi.mock("../../hooks/useGitStatus", () => ({
	useGitStatus: () => ({ data: undefined }),
}));
vi.mock("../../hooks/useGitSync", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../hooks/useGitSync")>()),
	useAutoFetch: () => {},
}));
vi.mock("../../hooks/useGitLog", () => ({
	useGitLog: () => ({ data: undefined }),
}));
vi.mock("../../hooks/useGitBranches", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../hooks/useGitBranches")>()),
	useGitBranches: () => ({ data: undefined }),
}));
vi.mock("../../hooks/useBranchMergeHandoff", () => ({
	useBranchMergeHandoff: () => ({
		handingOff: null,
		error: null,
		dismissError: () => {},
		start: () => {},
	}),
}));
vi.mock("./BranchBar", () => ({ default: () => null }));
vi.mock("./OperationBanner", () => ({ default: () => null }));
const listRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./ChangesSection", () => ({
	default: () => {
		listRenders.count++;
		return <div>changes list</div>;
	},
}));
vi.mock("./HistorySection", () => ({ default: () => <div>history list</div> }));
vi.mock("./BranchesSection", () => ({
	default: () => <div>branches list</div>,
}));

const STORAGE_KEY = "pockode:gitListWidth";

function Workspace({ segment, width }: { segment: GitSegment; width: number }) {
	const layer: GitLayer = { type: "git", segment };
	return (
		<div className="flex flex-col" style={{ width, height: 600 }}>
			<GitWorkspace
				layer={layer}
				onBack={() => {}}
				onSelectSegment={() => {}}
				onSelectFile={() => {}}
				onSelectCommit={() => {}}
				onSelectBranch={() => {}}
				onRepointBranch={() => {}}
				onCloseFile={() => {}}
			/>
		</div>
	);
}

function renderAt(width: number, segment: GitSegment = "changes") {
	const view = render(<Workspace segment={segment} width={width} />);
	return {
		rerender: (next: { segment?: GitSegment; width?: number }) =>
			view.rerender(
				<Workspace
					segment={next.segment ?? segment}
					width={next.width ?? width}
				/>,
			),
	};
}

const handle = () => screen.getByRole("separator", { name: "Resize list" });
const segmentControl = () =>
	screen.getByRole("group", { name: "Which part of the repository to show" });
const widthOf = (element: Element) =>
	Math.round(element.getBoundingClientRect().width);
/** The column the handle is the right edge of. */
const listColumn = () => {
	const id = handle().getAttribute("aria-controls");
	const column = id && document.getElementById(id);
	if (!column) throw new Error("the handle names no column");
	return column;
};
const listWidth = () => widthOf(listColumn());

/**
 * A mouse drag of the handle by `dx`, dispatched by hand: the hook reads
 * only the travel, and pointer 1 is the mouse, which both engines here let
 * an element capture from a synthetic press.
 */
function drag(dx: number) {
	const target = handle();
	const rect = target.getBoundingClientRect();
	const x = rect.left + rect.width / 2;
	const init = {
		bubbles: true,
		cancelable: true,
		pointerId: 1,
		pointerType: "mouse",
		isPrimary: true,
		button: 0,
		buttons: 1,
		clientY: rect.top + 10,
	};
	act(() => {
		target.dispatchEvent(
			new PointerEvent("pointerdown", { ...init, clientX: x }),
		);
	});
	act(() => {
		target.dispatchEvent(
			new PointerEvent("pointermove", { ...init, clientX: x + dx }),
		);
	});
	act(() => {
		target.dispatchEvent(
			new PointerEvent("pointerup", { ...init, buttons: 0, clientX: x + dx }),
		);
	});
}

/** Lets the row's ResizeObserver report a width the test set. */
const settle = () =>
	act(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);

beforeEach(() => {
	localStorage.removeItem(STORAGE_KEY);
});

describe("GitWorkspace list column", () => {
	it("starts at 40% of the row, within 320..560", () => {
		renderAt(1000);
		expect(listWidth()).toBe(400);
	});

	it("follows the row by default, within 320..560", async () => {
		const view = renderAt(1000);
		view.rerender({ width: 1600 });
		await settle();
		expect(listWidth()).toBe(560);
		view.rerender({ width: 780 });
		await settle();
		expect(listWidth()).toBe(300);
	});

	it("moves its edge with a drag and keeps the width", () => {
		renderAt(1200);
		const before = listWidth();

		drag(60);

		expect(listWidth()).toBe(before + 60);
		expect(localStorage.getItem(STORAGE_KEY)).toBe(`${before + 60}`);
	});

	// A drag sets the width on every pointer move; the columns' contents — a
	// long list, a large diff — must not be rendered again for each one.
	it("drags without rendering the list again", () => {
		renderAt(1200);
		const before = listRenders.count;

		drag(60);

		expect(listRenders.count).toBe(before);
	});

	it("is held between 280px and leaving the detail 480px", () => {
		renderAt(1200);

		drag(2000);
		expect(listWidth()).toBe(1200 - 480);

		drag(-2000);
		expect(listWidth()).toBe(280);
	});

	it("gives a chosen width back once a narrowed row has room again", async () => {
		const view = renderAt(1200);
		drag(1000);
		expect(listWidth()).toBe(720);

		view.rerender({ width: 1000 });
		await settle();
		expect(listWidth()).toBe(520);

		// Too narrow for both: the list keeps its minimum.
		view.rerender({ width: 700 });
		await settle();
		expect(listWidth()).toBe(280);

		view.rerender({ width: 1200 });
		await settle();
		expect(listWidth()).toBe(720);
	});

	// A control that moves once pressed sends the next press somewhere else.
	it("keeps the list column and the control in place across the segments", () => {
		const view = renderAt(1200);
		drag(-80);
		const box = (element: Element) => {
			const rect = element.getBoundingClientRect();
			return [rect.left, rect.width].map(Math.round);
		};
		const place = () => ({
			column: box(listColumn()),
			control: box(segmentControl()),
		});
		const before = place();

		for (const segment of ["history", "branches", "changes"] as const) {
			view.rerender({ segment });
			expect(place(), segment).toEqual(before);
		}
	});

	it("goes back to the default on a double-click", () => {
		renderAt(1000);
		drag(100);
		expect(listWidth()).toBe(500);

		act(() => {
			handle().dispatchEvent(
				new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
			);
		});

		expect(listWidth()).toBe(400);
		expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
	});
});
