import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import BadgeCount from "./BadgeCount";

describe("BadgeCount", () => {
	it("shows the count", () => {
		render(<BadgeCount count={1} />);
		expect(screen.getByText("1")).toBeInTheDocument();
	});

	it("renders nothing when there is nothing to report", () => {
		const { container, rerender } = render(<BadgeCount count={0} />);
		expect(container).toBeEmptyDOMElement();

		rerender(<BadgeCount count={undefined} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("shows counts up to 99 exactly", () => {
		render(<BadgeCount count={99} />);
		expect(screen.getByText("99")).toBeInTheDocument();
	});

	it("truncates counts above 99", () => {
		render(<BadgeCount count={100} />);
		expect(screen.getByText("99+")).toBeInTheDocument();
	});
});
