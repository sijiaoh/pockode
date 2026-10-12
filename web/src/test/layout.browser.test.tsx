import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

// Proves the browser entry lays out with the app's stylesheet: every number
// below is one jsdom reports as 0 and one Tailwind has to have compiled.
describe("browser layout", () => {
	it("sizes a scroll box from its classes and clamps scrolling to its content", () => {
		render(
			<div data-testid="box" className="h-40 overflow-y-auto">
				<div className="h-[1000px]" />
			</div>,
		);
		const box = screen.getByTestId("box");

		expect(box.clientHeight).toBe(160);
		expect(box.scrollHeight).toBe(1000);

		box.scrollTop = 300;
		expect(box.scrollTop).toBe(300);

		box.scrollTop = 10_000;
		expect(box.scrollTop).toBe(840);
	});
});
