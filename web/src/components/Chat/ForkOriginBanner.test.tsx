import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "../../lib/sessionStore";
import type { SessionListItem } from "../../types/message";
import ForkOriginBanner from "./ForkOriginBanner";

const parent: SessionListItem = {
	id: "parent-session",
	title: "Refactor the session store",
	created_at: "2024-01-01T00:00:00Z",
	updated_at: "2024-01-01T00:00:00Z",
	mode: "default",
	agent_type: "claude",
	activated: true,
	state: "idle",
	needs_input: false,
	unread: false,
};

describe("ForkOriginBanner", () => {
	beforeEach(() => {
		useSessionStore.setState({ sessions: [] });
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
});
