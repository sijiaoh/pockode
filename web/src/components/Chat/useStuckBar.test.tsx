import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStuckBar } from "./useStuckBar";

const BAR_TOP = 44;

function Pinned() {
	const ref = useRef<HTMLDivElement>(null);
	useStuckBar(ref, true);
	return (
		<div style={{ overflowY: "auto" }} data-testid="scroller">
			<div data-testid="section">
				<div ref={ref} data-testid="bar" style={{ top: `${BAR_TOP}px` }} />
			</div>
		</div>
	);
}

function rect(top: number): DOMRect {
	return { top, bottom: top + 24, height: 400 } as DOMRect;
}

afterEach(() => {
	vi.restoreAllMocks();
});

// The scroller's top edge is at 0. A bar sticking below it — a section
// header under a row's title — is pinned at its own `top`, not at the edge.
describe("useStuckBar", () => {
	function layOut(sectionTop: number, barTop: number) {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
			function (this: HTMLElement) {
				const id = this.dataset.testid;
				if (id === "section") return rect(sectionTop);
				if (id === "bar") return rect(barTop);
				return rect(0);
			},
		);
	}

	// The section has started above the header's place, though not above the
	// scroller's edge.
	it("marks a bar pinned at its own top below the scroller's edge", () => {
		layOut(20, BAR_TOP);
		const { getByTestId } = render(<Pinned />);
		expect(getByTestId("bar")).toHaveAttribute("data-stuck");
	});

	// Still below the scroller's edge, but above its place: the end of its
	// section is carrying it out.
	it("does not mark a bar the end of its section is carrying off", () => {
		layOut(-300, 10);
		const { getByTestId } = render(<Pinned />);
		expect(getByTestId("bar")).not.toHaveAttribute("data-stuck");
	});
});
