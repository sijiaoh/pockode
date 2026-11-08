import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import ResizeHandle from "../components/ui/ResizeHandle";
import { useResizableWidth } from "./useResizableWidth";

const KEY = "test:width";

interface HarnessProps {
	min?: number;
	max?: number;
	defaultWidth?: number;
}

// jsdom has no pointer capture.
HTMLElement.prototype.setPointerCapture = () => {};

function Harness({ min = 200, max = 600, defaultWidth = 300 }: HarnessProps) {
	const resize = useResizableWidth({
		storageKey: KEY,
		min,
		max,
		defaultWidth,
		active: true,
	});
	return (
		<div id="column" style={{ width: resize.width }}>
			<ResizeHandle
				resize={resize}
				label="Resize"
				controls="column"
				onDoubleClick={resize.reset}
			/>
		</div>
	);
}

const handle = () => screen.getByRole("separator", { name: "Resize" });
const width = () => handle().getAttribute("aria-valuenow");

function drag(
	from: number,
	path: number | number[],
	end: "pointerUp" | "pointerCancel",
) {
	const el = handle();
	fireEvent.pointerDown(el, { pointerId: 1, clientX: from });
	for (const x of [path].flat()) {
		fireEvent.pointerMove(el, { pointerId: 1, clientX: x });
	}
	fireEvent[end](el, { pointerId: 1 });
}

describe("useResizableWidth", () => {
	afterEach(() => {
		localStorage.clear();
	});

	// A default relative to the container keeps tracking it until the user
	// picks a width of their own.
	it("follows the default until the user chooses a width", () => {
		const { rerender } = render(<Harness defaultWidth={300} />);
		expect(width()).toBe("300");

		rerender(<Harness defaultWidth={350} />);
		expect(width()).toBe("350");
	});

	// The edge moves by the pointer's travel, wherever the column starts and
	// wherever on the strip it was grabbed.
	it("resizes by the drag's travel and keeps the width on release", () => {
		render(<Harness />);

		drag(1000, 1040, "pointerUp");

		expect(width()).toBe("340");
		expect(localStorage.getItem(KEY)).toBe("340");
	});

	it("follows a drag that comes back to where it started", () => {
		render(<Harness />);

		drag(1000, [1040, 1000], "pointerUp");

		expect(width()).toBe("300");
		expect(localStorage.getItem(KEY)).toBe("300");
	});

	// The browser can take the gesture for a scroll; what the user saw stays.
	it("keeps the width reached when the drag is cancelled", () => {
		render(<Harness />);

		drag(1000, 950, "pointerCancel");

		expect(localStorage.getItem(KEY)).toBe("250");
	});

	it("holds a drag within the limits", () => {
		render(<Harness />);

		drag(1000, 2000, "pointerUp");
		expect(width()).toBe("600");

		drag(1000, 0, "pointerUp");
		expect(width()).toBe("200");
	});

	// A max that follows the container only bounds what is drawn: the user's
	// width comes back once the container has room for it again.
	it("draws a stored width within a shrunken max and restores it later", () => {
		localStorage.setItem(KEY, "500");
		const { rerender } = render(<Harness max={400} />);
		expect(width()).toBe("400");
		expect(handle()).toHaveAttribute("aria-valuemax", "400");

		rerender(<Harness max={600} />);
		expect(width()).toBe("500");
		expect(localStorage.getItem(KEY)).toBe("500");
	});

	it("keeps the minimum when the container is too narrow for both limits", () => {
		render(<Harness min={280} max={100} />);

		expect(width()).toBe("280");
		expect(handle()).toHaveAttribute("aria-valuemax", "280");
	});

	// The clicks of a double-click among them: a press that does not move
	// chooses nothing, so the default keeps following the container.
	it("chooses nothing on a press that does not move", () => {
		const { rerender } = render(<Harness />);

		drag(1000, 1000, "pointerUp");
		rerender(<Harness defaultWidth={350} />);

		expect(width()).toBe("350");
		expect(localStorage.getItem(KEY)).toBeNull();
	});

	it("ignores a stored width it cannot read", () => {
		localStorage.setItem(KEY, "abc");
		render(<Harness />);
		expect(width()).toBe("300");
	});

	// A minimum raised since the width was chosen: the nearest to it is the
	// narrowest the column now goes, not the default the user had left.
	it("draws a stored width under the minimum at the minimum", () => {
		localStorage.setItem(KEY, "100");
		render(<Harness />);
		expect(width()).toBe("200");
	});

	// After a reset the default is relative again, not frozen at the value it
	// had when the reset happened.
	it("returns to the default on reset and forgets the choice", async () => {
		const user = userEvent.setup();
		localStorage.setItem(KEY, "450");
		const { rerender } = render(<Harness />);

		await user.dblClick(handle());
		expect(width()).toBe("300");
		expect(localStorage.getItem(KEY)).toBeNull();

		rerender(<Harness defaultWidth={320} />);
		expect(width()).toBe("320");
	});
});
