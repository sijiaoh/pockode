import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkListItem } from "../../types/work";
import WorkRow from "./WorkRow";

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: unknown) => unknown) =>
		selector({
			actions: {
				startWork: vi.fn(() => Promise.resolve()),
				stopWork: vi.fn(() => Promise.resolve()),
				reopenWork: vi.fn(() => Promise.resolve()),
			},
		}),
}));

// The badge decides for itself whether a worktree is settled enough to name;
// the row only has to place it, so the two answers are given here directly.
let badgeVisible = false;
vi.mock("../Worktree", () => ({
	WorktreeBadge: () => <span>feature-x</span>,
	useWorktreeBadgeVisible: () => badgeVisible,
}));

const work = (overrides: Partial<WorkListItem> = {}): WorkListItem => ({
	id: "work-1",
	type: "story",
	title: "Rebuild the project page",
	status: "active",
	activity: "running",
	updated_at: "2026-03-04T00:00:00Z",
	...overrides,
});

/** The line of facts under the title, as the user reads it left to right. */
function metaLine(): string {
	const role = screen.getByText("Engineer");
	return role.closest("div")?.textContent ?? "";
}

function renderRow(props: Partial<Parameters<typeof WorkRow>[0]> = {}) {
	const onOpen = vi.fn();
	const onOpenChat = vi.fn();
	render(
		<WorkRow
			work={work()}
			onOpen={onOpen}
			onOpenChat={onOpenChat}
			{...props}
		/>,
	);
	return { onOpen, onOpenChat };
}

describe("WorkRow", () => {
	beforeEach(() => {
		badgeVisible = false;
	});

	it("opens the work from its title, whatever else the row offers", async () => {
		const user = userEvent.setup();
		const { onOpen } = renderRow({
			work: work({ id: "story-7", session_id: "session-1" }),
		});

		await user.click(
			screen.getByRole("button", {
				name: "Rebuild the project page — Running",
			}),
		);

		expect(onOpen).toHaveBeenCalledWith("story-7");
	});

	// A screen reader walking a list meets a column of identical verbs otherwise.
	it("names the work in both icon controls", () => {
		renderRow({
			work: work({ status: "open", activity: "open", session_id: "s-1" }),
		});

		expect(
			screen.getByRole("button", { name: 'Start "Rebuild the project page"' }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: 'Open chat for "Rebuild the project page"',
			}),
		).toBeInTheDocument();
	});

	it("offers the chat only when the work has a session, in its own worktree", async () => {
		const user = userEvent.setup();
		expect(
			render(
				<WorkRow work={work()} onOpen={vi.fn()} onOpenChat={vi.fn()} />,
			).queryByRole("button", { name: /Open chat/ }),
		).toBeNull();

		const { onOpenChat } = renderRow({
			work: work({ session_id: "session-abc", worktree: "feature-x" }),
		});
		await user.click(
			screen.getByRole("button", {
				name: 'Open chat for "Rebuild the project page"',
			}),
		);

		expect(onOpenChat).toHaveBeenCalledWith("session-abc", "feature-x");
	});

	it("keeps the slots in one order whatever the row is", () => {
		badgeVisible = true;
		renderRow({
			work: work({
				type: "task",
				activity: "needs_answer",
				wait: "user",
			}),
			parentTitle: "Cluster mode",
			roleName: "Engineer",
		});

		expect(metaLine()).toBe("Needs answer·in: Cluster mode·feature-x·Engineer");
	});

	it("rolls its children up into the story's own line", () => {
		renderRow({
			work: work(),
			roleName: "Engineer",
			tasks: [
				work({ id: "t1", type: "task", status: "active" }),
				work({ id: "t2", type: "task", status: "closed" }),
				work({ id: "t3", type: "task", status: "open" }),
			],
		});

		expect(metaLine()).toBe("Engineer·1 active·1/3 tasks");
	});

	// §3.1: the story detail's children section drops the parent slot, and that
	// is the only difference between the two screens' rows.
	it("leaves the parent unnamed when the screen does not pass one", () => {
		renderRow({
			work: work({ type: "task" }),
			roleName: "Engineer",
		});

		expect(metaLine()).toBe("Engineer");
	});

	// The bar already says someone is blocked; slot 1 says what kind of answer is
	// wanted, which only the needs-you leaves have.
	it("writes no activity label for a work nobody is waiting on", () => {
		renderRow({ work: work({ status: "stopped", activity: "stopped" }) });

		expect(screen.queryByText("Stopped")).toBeNull();
	});

	it("dates a row only where the list is sorted by it", () => {
		renderRow({ work: work({ status: "closed", activity: "closed" }) });
		expect(screen.queryByText(/ago|just now|yesterday/)).toBeNull();

		renderRow({
			work: work({ status: "closed", activity: "closed" }),
			showUpdatedAt: true,
		});
		expect(screen.getByText(/ago|just now|yesterday/)).toBeInTheDocument();
	});

	// No row expands: children are listed in exactly one place, the story's
	// detail page.
	it("holds no children and no way to ask for them", () => {
		renderRow({
			work: work(),
			tasks: [work({ id: "t1", type: "task", title: "A child task" })],
		});

		expect(screen.queryByText("A child task")).toBeNull();
		expect(
			screen.queryByRole("button", { name: /expand|collapse/i }),
		).toBeNull();
	});

	it("titles itself at the level the screen around it is written in", () => {
		renderRow({ headingLevel: 4 });

		expect(
			screen.getByRole("heading", {
				level: 4,
				name: /Rebuild the project page/,
			}),
		).toBeInTheDocument();
	});
});
