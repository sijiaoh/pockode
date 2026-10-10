import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FullScreenHost } from "./FullScreenHost";
import { HtmlRenderCard } from "./HtmlRenderCard";

const RUN = {
	id: "tool-page",
	name: "mcp__pockode__html_render",
	input: { title: "Latency report", html: "<h1>p99</h1>" },
	status: "success" as const,
};

describe("HtmlRenderCard full screen", () => {
	// A rendered page is out of find's reach, so find comes and goes with the
	// source — and never lingers out of sight to take the Escape that closes.
	it("offers find on the source alone, and Escape still closes after it", async () => {
		const user = userEvent.setup();
		render(
			<FullScreenHost>
				<HtmlRenderCard run={RUN} />
			</FullScreenHost>,
		);
		await user.click(
			screen.getByRole("button", { name: "Open page in full screen" }),
		);
		const dialog = screen.getByRole("dialog", { name: "Latency report" });
		expect(within(dialog).getByTitle("Latency report")).toBeInTheDocument();
		expect(within(dialog).queryByRole("button", { name: "Find" })).toBeNull();

		const toggle = within(dialog).getByRole("button", { name: "Show source" });
		await user.click(toggle);
		expect(within(dialog).queryByTitle("Latency report")).toBeNull();
		await user.click(within(dialog).getByRole("button", { name: "Find" }));
		expect(
			within(dialog).getByRole("textbox", { name: "Find in page" }),
		).toBeInTheDocument();

		await user.click(toggle);
		expect(
			within(dialog).queryByRole("textbox", { name: "Find in page" }),
		).toBeNull();
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});
