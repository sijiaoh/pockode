import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionDetailStore } from "../../lib/sessionDetailStore";
import { makeSessionDetail } from "../../test/sessionFixtures";
import SessionWorkSection from "./SessionWorkSection";

const bound = () =>
	makeSessionDetail({
		id: "s1",
		title: "Jump from the session page to its work",
		work_id: "work-1",
	});

describe("SessionWorkSection", () => {
	beforeEach(() => {
		useSessionDetailStore.getState().clear();
	});

	it("opens the work this session runs, closing the panel first", async () => {
		useSessionDetailStore.getState().setDetail("s1", bound());
		const calls: string[] = [];
		const onOpenWorkDetail = vi.fn(() => calls.push("open"));
		const onClose = vi.fn(() => calls.push("close"));
		const user = userEvent.setup();

		render(
			<SessionWorkSection
				sessionId="s1"
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
		useSessionDetailStore
			.getState()
			.setDetail("s1", makeSessionDetail({ id: "s1" }));

		const { container } = render(
			<SessionWorkSection
				sessionId="s1"
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
				sessionId="s1"
				onOpenWorkDetail={vi.fn()}
				onClose={vi.fn()}
			/>,
		);

		expect(container).toBeEmptyDOMElement();
		expect(screen.queryByText("Work")).not.toBeInTheDocument();
	});

	// The store holds one session at a time and the route can move ahead of it.
	it("renders nothing while the detail belongs to another session", () => {
		useSessionDetailStore.getState().setDetail("other", bound());

		const { container } = render(
			<SessionWorkSection
				sessionId="s1"
				onOpenWorkDetail={vi.fn()}
				onClose={vi.fn()}
			/>,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing when the embedder offers no work pages", () => {
		useSessionDetailStore.getState().setDetail("s1", bound());

		const { container } = render(
			<SessionWorkSection sessionId="s1" onClose={vi.fn()} />,
		);

		expect(container).toBeEmptyDOMElement();
	});
});
