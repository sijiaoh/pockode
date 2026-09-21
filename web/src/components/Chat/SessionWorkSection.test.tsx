import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeSessionDetail } from "../../test/sessionFixtures";
import SessionWorkSection from "./SessionWorkSection";

const bound = () =>
	makeSessionDetail({
		id: "s1",
		title: "Jump from the session page to its work",
		work_id: "work-1",
	});

describe("SessionWorkSection", () => {
	it("opens the work this session runs, closing the panel first", async () => {
		const calls: string[] = [];
		const onOpenWorkDetail = vi.fn(() => calls.push("open"));
		const onClose = vi.fn(() => calls.push("close"));
		const user = userEvent.setup();

		render(
			<SessionWorkSection
				detail={bound()}
				onOpenWorkDetail={onOpenWorkDetail}
				onClose={onClose}
			/>,
		);

		await user.click(
			screen.getByRole("button", {
				name: "Jump from the session page to its work",
			}),
		);

		expect(onOpenWorkDetail).toHaveBeenCalledWith("work-1");
		// The panel is a navigation target away from itself; opening the overlay
		// behind an open panel would leave the user closing it by hand.
		expect(calls).toEqual(["close", "open"]);
	});

	it("renders nothing for a session that runs no work", () => {
		const { container } = render(
			<SessionWorkSection
				detail={makeSessionDetail({ id: "s1" })}
				onOpenWorkDetail={vi.fn()}
				onClose={vi.fn()}
			/>,
		);

		// Nothing at all, not an empty node: the section below this one draws its
		// divider with a `:first-child` rule.
		expect(container).toBeEmptyDOMElement();
	});

	// The absence of a detail is not evidence that there is no work — it is a
	// round trip that has not landed, or a connection that has dropped.
	it("renders nothing while the detail has not arrived", () => {
		const { container } = render(
			<SessionWorkSection
				detail={null}
				onOpenWorkDetail={vi.fn()}
				onClose={vi.fn()}
			/>,
		);

		expect(container).toBeEmptyDOMElement();
		expect(screen.queryByText("Work")).not.toBeInTheDocument();
	});

	it("renders nothing when the embedder offers no work pages", () => {
		const { container } = render(
			<SessionWorkSection detail={bound()} onClose={vi.fn()} />,
		);

		expect(container).toBeEmptyDOMElement();
	});
});
