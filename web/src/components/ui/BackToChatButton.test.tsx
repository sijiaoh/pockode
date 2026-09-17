import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionDetailStore } from "../../lib/sessionDetailStore";
import { makeSessionDetail } from "../../test/sessionFixtures";
import BackToChatButton from "./BackToChatButton";

let routeSessionId = "s1";

vi.mock("../../hooks/useRouteState", () => ({
	useRouteState: () => ({ sessionId: routeSessionId }),
}));

/** The dot has no text of its own; it is the button's only child element. */
const hasDot = () =>
	screen.getByRole("button", { name: "Back to chat" }).querySelector("span") !==
	null;

describe("BackToChatButton", () => {
	beforeEach(() => {
		routeSessionId = "s1";
		useSessionDetailStore.getState().clear();
	});

	// Read from the open session's own metadata rather than from the session
	// list: the list is narrowed server-side and leaves out exactly the sessions
	// a work item drives, so a dot sourced there would never light for the one
	// kind of session this overlay is most often opened from.
	it("lights when the session it goes back to is unread", () => {
		useSessionDetailStore
			.getState()
			.setDetail("s1", makeSessionDetail({ id: "s1", unread: true }));

		render(<BackToChatButton onClick={vi.fn()} />);

		expect(hasDot()).toBe(true);
	});

	it("stays dark when it is read", () => {
		useSessionDetailStore
			.getState()
			.setDetail("s1", makeSessionDetail({ id: "s1", unread: false }));

		render(<BackToChatButton onClick={vi.fn()} />);

		expect(hasDot()).toBe(false);
	});

	// The store holds one session at a time and the route can move a render
	// ahead of it. A verdict about the session just left must not be shown under
	// the one just opened.
	it("says nothing while the metadata belongs to another session", () => {
		useSessionDetailStore
			.getState()
			.setDetail("other", makeSessionDetail({ id: "other", unread: true }));

		render(<BackToChatButton onClick={vi.fn()} />);

		expect(hasDot()).toBe(false);
	});
});
