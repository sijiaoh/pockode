import { render } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { scrollSpanIntoView, useRevealLitRow } from "./revealRow";

// jsdom lays nothing out, so the scroller's height and offset are given here;
// that the rows really end up on screen is HistoryList.browser.test.tsx's.

/** A 200px-tall scroller, scrolled to `scrollTop`, over 2000px of content. */
function makeScroller(scrollTop: number, pinnedHeight = 0) {
	const scroller = document.createElement("div");
	let top = scrollTop;
	Object.defineProperty(scroller, "scrollTop", {
		get: () => top,
		set: (v: number) => {
			top = Math.max(0, Math.min(v, 2000 - 200));
		},
	});
	Object.defineProperty(scroller, "clientHeight", { value: 200 });
	if (pinnedHeight) {
		const header = document.createElement("div");
		header.style.position = "sticky";
		Object.defineProperty(header, "offsetHeight", { value: pinnedHeight });
		scroller.append(header);
	}
	return scroller;
}

describe("scrollSpanIntoView", () => {
	it("leaves a span already in view where it is", () => {
		const scroller = makeScroller(100);
		scrollSpanIntoView(scroller, 150, 200);
		expect(scroller.scrollTop).toBe(100);
	});

	it("scrolls down just far enough to show a span below the view", () => {
		const scroller = makeScroller(0);
		scrollSpanIntoView(scroller, 500, 552);
		expect(scroller.scrollTop).toBe(352);
	});

	it("scrolls up to a span above the view, below what is pinned there", () => {
		const scroller = makeScroller(600, 44);
		scrollSpanIntoView(scroller, 300, 352);
		expect(scroller.scrollTop).toBe(256);
	});

	it("counts a span under the pinned header as out of view", () => {
		const scroller = makeScroller(300, 44);
		scrollSpanIntoView(scroller, 320, 372);
		expect(scroller.scrollTop).toBe(276);
	});
});

function Rows({
	lit,
	reveal,
}: {
	lit: number | null;
	reveal: (() => void) | undefined;
}) {
	const ref = useRef<HTMLDivElement>(null);
	useRevealLitRow(ref, reveal);
	return (
		<div ref={ref}>
			{[0, 1, 2, 3].map((i) => (
				<button
					key={i}
					type="button"
					aria-current={i === lit ? "true" : undefined}
				>
					row {i}
				</button>
			))}
		</div>
	);
}

describe("useRevealLitRow", () => {
	it("waits for the lit row to be listed, then reports it revealed once", () => {
		const reveal = vi.fn();
		const { rerender } = render(<Rows lit={null} reveal={reveal} />);
		expect(reveal).not.toHaveBeenCalled();

		rerender(<Rows lit={2} reveal={reveal} />);
		expect(reveal).toHaveBeenCalledTimes(1);

		rerender(<Rows lit={2} reveal={undefined} />);
		expect(reveal).toHaveBeenCalledTimes(1);
	});
});
