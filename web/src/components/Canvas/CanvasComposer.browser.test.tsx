import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposerDock } from "./CanvasComposer";

/**
 * A column the way the session screen lays one out: the canvas taking what
 * the dock leaves, a strip in the dock above a composer of `composer` px —
 * open, and floating, whenever `floating` is.
 */
function ui(
	floating: boolean,
	composer: number,
	onCover?: (height: number) => void,
) {
	return (
		<div style={{ height: 400, display: "flex", flexDirection: "column" }}>
			<div data-testid="canvas" style={{ flex: 1, minHeight: 0 }} />
			<ComposerDock floating={floating} open={floating} onCover={onCover}>
				<div data-testid="strip" style={{ height: 30 }} />
				<div data-testid="composer" style={{ height: composer }} />
			</ComposerDock>
		</div>
	);
}

const box = (id: string) => screen.getByTestId(id).getBoundingClientRect();

describe("the composer dock in a real browser", () => {
	it("floats over the canvas without moving it, with the strip riding on top", async () => {
		const { rerender } = render(ui(false, 50));
		expect(box("canvas").height).toBe(320);
		// The height it is held at is measured after the first paint.
		await new Promise((resolve) => requestAnimationFrame(resolve));

		rerender(ui(true, 200));
		expect(box("canvas").height).toBe(320);
		expect(box("composer").bottom).toBe(400);
		expect(box("strip").bottom).toBe(box("composer").top);
		expect(box("strip").top).toBeLessThan(box("canvas").bottom);

		rerender(ui(false, 50));
		expect(box("canvas").height).toBe(320);
	});

	it("goes back into the column rather than grow over what is above it", async () => {
		const { rerender } = render(ui(false, 50));
		await new Promise((resolve) => requestAnimationFrame(resolve));

		rerender(ui(true, 450));
		// Past the observers' first answers, which come after a frame's
		// callbacks: a measurement that flipped it back would show by then.
		for (let i = 0; i < 4; i++) {
			await new Promise((resolve) => requestAnimationFrame(resolve));
		}
		const column = screen.getByTestId("canvas").parentElement;
		if (!column) throw new Error("no column");
		expect(box("strip").top).toBeGreaterThanOrEqual(
			column.getBoundingClientRect().top,
		);
		expect(box("canvas").height).toBe(0);
		// In the column, not floating over it as a stale measure would leave it.
		const block = screen.getByTestId("strip").parentElement;
		if (!block) throw new Error("no block");
		expect(getComputedStyle(block).position).toBe("static");
	});

	it("floats again at its closed height once it fits, not at the open one", async () => {
		const { rerender } = render(ui(false, 50));
		await new Promise((resolve) => requestAnimationFrame(resolve));

		rerender(ui(true, 450));
		for (let i = 0; i < 4; i++) {
			await new Promise((resolve) => requestAnimationFrame(resolve));
		}
		expect(box("canvas").height).toBe(0);

		// The keyboard going down, say: the open composer fits again.
		rerender(ui(true, 200));
		for (let i = 0; i < 4; i++) {
			await new Promise((resolve) => requestAnimationFrame(resolve));
		}
		expect(box("canvas").height).toBe(320);
		expect(box("composer").bottom).toBe(400);
	});

	it("says how far it reaches over the canvas while floating, and none in the column", async () => {
		const onCover = vi.fn();
		const { rerender } = render(ui(false, 50, onCover));
		await new Promise((resolve) => requestAnimationFrame(resolve));
		expect(onCover).toHaveBeenLastCalledWith(0);

		// Held at the closed 80px; 230px floating over the canvas's bottom.
		rerender(ui(true, 200, onCover));
		expect(onCover).toHaveBeenLastCalledWith(150);

		// A draft growing.
		rerender(ui(true, 260, onCover));
		await vi.waitFor(() => expect(onCover).toHaveBeenLastCalledWith(210));

		// Put away: back in the column.
		rerender(ui(false, 50, onCover));
		expect(onCover).toHaveBeenLastCalledWith(0);
		await new Promise((resolve) => requestAnimationFrame(resolve));

		// Too tall to float: in the column, the canvas gives way instead.
		onCover.mockClear();
		rerender(ui(true, 450, onCover));
		await vi.waitFor(() => expect(onCover).toHaveBeenLastCalledWith(0));
	});
});
