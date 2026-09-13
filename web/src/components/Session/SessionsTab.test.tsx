import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSessionListItem } from "../../test/sessionFixtures";
import type { SessionListItem } from "../../types/message";
import { SidebarContext } from "../Layout/SidebarContext";
import SessionsTab from "./SessionsTab";

const mockRefresh = vi.fn();
const sessionState = {
	filteredSessions: [] as SessionListItem[],
	isLoading: false,
	isReloading: false,
};

vi.mock("../../hooks/useSession", () => ({
	useSession: () => ({ ...sessionState, refresh: mockRefresh }),
}));

const session = (id: string) => makeSessionListItem({ id, title: id });

// The sidebar bumps refreshSignal when it opens; raising it is how a test asks
// the tab to refresh.
function tab(refreshSignal: number, isSwitchingWorktree: boolean) {
	return (
		<SidebarContext.Provider value={{ activeTab: "sessions", refreshSignal }}>
			<SessionsTab
				currentSessionId="a1"
				onSelectSession={vi.fn()}
				onCreateSession={vi.fn()}
				onDeleteSession={vi.fn()}
				isSwitchingWorktree={isSwitchingWorktree}
			/>
		</SidebarContext.Provider>
	);
}

describe("SessionsTab", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		sessionState.filteredSessions = [session("a1")];
		sessionState.isLoading = false;
		sessionState.isReloading = false;
	});

	// Refreshing mid-switch resubscribes over a connection still bound to the
	// worktree being left, and the list that comes back looks authoritative
	// enough to release AppShell's redirect effect — which then bounces the user
	// off the session they were navigating to.
	it("does not refresh a list that belongs to the worktree being left", () => {
		const { rerender } = render(tab(0, true));

		rerender(tab(1, true));

		expect(mockRefresh).not.toHaveBeenCalled();
	});

	// The window the guard exists for. Once the store worktree has caught up,
	// isSwitchingWorktree is already false and AppShell's own gate on the redirect
	// effect is open; isReloading is all that still marks the list as the previous
	// worktree's.
	it("does not refresh once the switch has landed but the new list has not", () => {
		sessionState.isReloading = true;
		const { rerender } = render(tab(0, false));

		rerender(tab(1, false));

		expect(mockRefresh).not.toHaveBeenCalled();
	});

	it("refreshes when the list is the current worktree's", () => {
		const { rerender } = render(tab(0, false));

		rerender(tab(1, false));

		expect(mockRefresh).toHaveBeenCalledTimes(1);
	});

	// A session created now would land in whichever worktree the connection is
	// still bound to, which is not the one the user is on their way to.
	it("blocks new chats while the worktree switch is in flight", () => {
		render(tab(0, true));

		expect(screen.getByRole("button", { name: /New Chat/ })).toBeDisabled();
	});
});
