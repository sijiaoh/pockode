import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { CollapsibleBody } from "./CollapsibleBody";

function Collapsible({ body }: { body: React.ReactNode }) {
	const [expanded, setExpanded] = useState(false);
	return (
		<div>
			<button
				type="button"
				aria-expanded={expanded}
				onClick={() => setExpanded(!expanded)}
			>
				Toggle
			</button>
			<CollapsibleBody expanded={expanded}>{body}</CollapsibleBody>
		</div>
	);
}

describe("CollapsibleBody", () => {
	it("renders nothing until the region is first expanded", async () => {
		const user = userEvent.setup();
		render(<Collapsible body={<p>body content</p>} />);

		expect(screen.queryByText("body content")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Toggle" }));
		expect(screen.getByText("body content")).toBeVisible();
	});

	it("hides the body on collapse instead of discarding it", async () => {
		const user = userEvent.setup();
		render(<Collapsible body={<p>body content</p>} />);
		const toggle = screen.getByRole("button", { name: "Toggle" });

		await user.click(toggle);
		await user.click(toggle);

		expect(screen.getByText("body content")).not.toBeVisible();
	});

	it("keeps what the body held across a collapse and reopen", async () => {
		const user = userEvent.setup();
		render(<Collapsible body={<input aria-label="Note" />} />);
		const toggle = screen.getByRole("button", { name: "Toggle" });

		await user.click(toggle);
		await user.type(screen.getByRole("textbox", { name: "Note" }), "kept");
		await user.click(toggle);
		await user.click(toggle);

		expect(screen.getByRole("textbox", { name: "Note" })).toHaveValue("kept");
	});
});
