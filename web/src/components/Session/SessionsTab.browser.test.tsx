import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { SidebarContext } from "../Layout/SidebarContext";
import SessionsTab from "./SessionsTab";

// What jsdom cannot say: where the filter's dropdown is drawn against the
// sidebar column, which clips whatever leaves it.

vi.mock("@pockode/shared", async (importOriginal) => ({
	...(await importOriginal<typeof import("@pockode/shared")>()),
	useIsExpanded: () => true,
}));
vi.mock("../../hooks/useSession", () => ({
	useSession: () => ({
		sessions: [],
		isLoading: false,
		isReloading: false,
		refresh: () => {},
	}),
}));
const wsState = {
	status: "connected",
	actions: {
		sessionViewWorktrees: async () => [],
		sessionViewList: async () => ({ sessions: [], next_cursor: null }),
	},
};
vi.mock("../../lib/wsStore", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/wsStore")>()),
	useWSStore: Object.assign(
		(selector: (state: unknown) => unknown) => selector(wsState),
		{ getState: () => wsState },
	),
	wsActions: { listWorktrees: () => {} },
}));
vi.mock("../../hooks/useWorktreeList", () => ({
	useWorktreeList: () => [
		{ name: "", branch: "main", path: "/repo", is_main: true },
	],
}));

beforeEach(async () => {
	await page.viewport(1280, 800);
});

afterEach(async () => {
	await page.viewport(414, 896);
});

// 280px is the narrowest the sidebar column goes (Layout/Sidebar.tsx).
it("keeps the filter's dropdown inside the column at its narrowest", async () => {
	const user = userEvent.setup();
	render(
		<QueryClientProvider client={new QueryClient()}>
			<SidebarContext.Provider
				value={{ activeTab: "sessions", refreshSignal: 0 }}
			>
				<div
					data-testid="column"
					className="flex flex-col overflow-hidden"
					style={{ width: 280, height: 600 }}
				>
					<SessionsTab
						currentSessionId={null}
						onSelectSession={() => {}}
						onCreateSession={() => {}}
						onDeleteSession={() => {}}
						isSwitchingWorktree={false}
					/>
				</div>
			</SidebarContext.Provider>
		</QueryClientProvider>,
	);

	await user.click(screen.getByRole("button", { name: /Filter sessions/ }));

	const panel = screen
		.getByRole("dialog", { name: "Filter sessions" })
		.getBoundingClientRect();
	const column = screen.getByTestId("column").getBoundingClientRect();
	expect(panel.left).toBeGreaterThanOrEqual(column.left);
	expect(panel.right).toBeLessThanOrEqual(column.right);
});
