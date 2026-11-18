import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContentErrorBoundary } from "./ContentErrorBoundary";

let failing: Set<string>;

function Content({ path }: { path: string }) {
	if (failing.has(path)) throw new Error(`cannot draw ${path}`);
	return <p>drawn {path}</p>;
}

function View({ path }: { path: string }) {
	return (
		<>
			<ContentErrorBoundary name={path} resetKey={path}>
				<Content path={path} />
			</ContentErrorBoundary>
			<p>the page around it</p>
		</>
	);
}

describe("ContentErrorBoundary", () => {
	beforeEach(() => {
		failing = new Set();
		// React reports what a boundary caught on the console; the report is
		// not what is under test.
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.mocked(console.error).mockRestore();
	});

	it("keeps a throw to the view that threw, saying what it was", () => {
		failing.add("a.txt");
		render(<View path="a.txt" />);

		expect(screen.getByRole("alert").textContent).toContain(
			"Couldn't show a.txt",
		);
		expect(screen.getByText("cannot draw a.txt")).toBeTruthy();
		expect(screen.getByText("the page around it")).toBeTruthy();
	});

	it("draws the next file afresh", () => {
		failing.add("a.txt");
		const { rerender } = render(<View path="a.txt" />);

		rerender(<View path="b.txt" />);

		expect(screen.getByText("drawn b.txt")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("tries the same file again when asked", async () => {
		const user = userEvent.setup();
		failing.add("a.txt");
		render(<View path="a.txt" />);

		failing.clear();
		await user.click(screen.getByRole("button", { name: "Retry" }));

		expect(screen.getByText("drawn a.txt")).toBeTruthy();
	});

	it("offers the text it failed to draw, to be read as it is", async () => {
		const user = userEvent.setup();
		failing.add("a.diff");
		render(
			<ContentErrorBoundary name="a.diff" resetKey="a.diff" raw="@@ raw patch">
				<Content path="a.diff" />
			</ContentErrorBoundary>,
		);

		expect(screen.queryByText("@@ raw patch")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Show raw" }));
		expect(screen.getByText("@@ raw patch")).toBeTruthy();
	});
});
