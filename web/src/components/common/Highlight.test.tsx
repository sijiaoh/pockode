import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Highlight from "./Highlight";

describe("Highlight", () => {
	it("marks every case-insensitive occurrence", () => {
		render(<Highlight text="Foo foo FOO" query="foo" />);

		const marks = screen.getAllByText(/foo/i, { selector: "mark" });
		expect(marks.map((mark) => mark.textContent)).toEqual([
			"Foo",
			"foo",
			"FOO",
		]);
	});

	it("renders plain text when nothing matches", () => {
		const { container } = render(<Highlight text="bar" query="foo" />);

		expect(container.querySelector("mark")).toBeNull();
		expect(container).toHaveTextContent("bar");
	});

	it("renders plain text for an empty query", () => {
		const { container } = render(<Highlight text="bar" query="" />);

		expect(container.querySelector("mark")).toBeNull();
	});

	it("treats regex metacharacters literally", () => {
		const { container } = render(<Highlight text="a.c abc" query="a.c" />);

		const marks = container.querySelectorAll("mark");
		expect(marks).toHaveLength(1);
		expect(marks[0]).toHaveTextContent("a.c");
	});

	it("skips highlighting when lowercasing would shift indexes", () => {
		// "İ".toLowerCase() is two code units, so indexes from the lowercased copy
		// would cut the original mid-character.
		const { container } = render(<Highlight text="İstanbul" query="stan" />);

		expect(container.querySelector("mark")).toBeNull();
		expect(container).toHaveTextContent("İstanbul");
	});
});
