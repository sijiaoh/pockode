import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Highlight from "./Highlight";

function marked(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll("mark"), (m) => m.textContent);
}

describe("Highlight", () => {
	it("marks exactly the given ranges and keeps the rest as text", () => {
		const { container } = render(
			<Highlight
				text="useFileSearch.ts"
				ranges={[
					{ start: 0, end: 1 },
					{ start: 3, end: 7 },
					{ start: 15, end: 16 },
				]}
			/>,
		);

		expect(marked(container)).toEqual(["u", "File", "s"]);
		expect(container).toHaveTextContent("useFileSearch.ts");
	});

	it("renders plain text without ranges", () => {
		const { container } = render(<Highlight text="bar" ranges={[]} />);

		expect(container.querySelector("mark")).toBeNull();
		expect(container).toHaveTextContent("bar");
	});

	it("slices by UTF-16 code units, so astral characters stay whole", () => {
		// "😀" is two code units; the server counts it the same way.
		const { container } = render(
			<Highlight text="a😀b" ranges={[{ start: 1, end: 3 }]} />,
		);

		expect(marked(container)).toEqual(["😀"]);
	});
});
