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
	// promise a session the list cannot produce.
	it("degrades to plain text when the parent has no row", () => {
		render(
			<ForkOriginBanner
				parentSessionId="parent-session"
				onOpenParent={vi.fn()}
			/>,
		);

		expect(
			screen.getByText("Forked from a session that is not in the list"),
		).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});

	// An absence is never evidence, whatever the filter is doing: the list is
	// narrowed server-side *and* it is a page, so a missing row means the parent
	// is hidden, or further down than the user has read — never that it is gone
	// (docs/list-paging-ui.md §2.3).
	it("never calls the parent deleted, filter or no filter", () => {
		for (const showTaskSessions of [true, false]) {
			useSessionStore.setState({ sessions: [], showTaskSessions });
			const { unmount } = render(
				<ForkOriginBanner
					parentSessionId="parent-session"
					onOpenParent={vi.fn()}
				/>,
			);

			expect(screen.queryByText(/deleted/)).toBeNull();
			unmount();
		}
	});
});
