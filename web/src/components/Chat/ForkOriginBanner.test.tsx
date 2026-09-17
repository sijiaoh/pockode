import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "../../lib/sessionStore";
import { makeSessionListItem } from "../../test/sessionFixtures";
import ForkOriginBanner from "./ForkOriginBanner";

const parent = makeSessionListItem({
	id: "parent-session",
	title: "Refactor the session store",
});

describe("ForkOriginBanner", () => {
	beforeEach(() => {
		useSessionStore.setState({ sessions: [], showTaskSessions: true });
	});

	it("names the parent and links to it", () => {
		useSessionStore.setState({ sessions: [parent] });
		render(
			<ForkOriginBanner
				parentSessionId="parent-session"
				onOpenParent={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("button", {
				name: 'Forked from "Refactor the session store"',
			}),
		).toBeInTheDocument();
	});

	// Not a button: there is nowhere to go, and offering the tap anyway would
	// promise a session that is gone.
	it("degrades to plain text when the parent has been deleted", () => {
		render(
			<ForkOriginBanner
				parentSessionId="parent-session"
				onOpenParent={vi.fn()}
			/>,
		);

		expect(
			screen.getByText("Forked from a deleted session"),
		).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});

	// An absent parent is only proof of deletion while nothing is being hidden.
	// The list is narrowed server-side, and a fork of a work session has for its
	// parent exactly the kind of session that narrowing removes — so with the
	// filter on the banner must not call a living session deleted.
	it("does not call the parent deleted while task sessions are hidden", () => {
		useSessionStore.setState({ showTaskSessions: false });
		render(
			<ForkOriginBanner
				parentSessionId="parent-session"
				onOpenParent={vi.fn()}
			/>,
		);

		expect(screen.queryByText(/deleted/)).toBeNull();
		expect(
			screen.getByText("Forked from a session that is not in the list"),
		).toBeInTheDocument();
	});
});
