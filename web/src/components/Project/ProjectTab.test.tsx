import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity } from "../../lib/activity";
import { useScheduleStore } from "../../lib/scheduleStore";
import { useWorkStore } from "../../lib/workStore";
import { makeSchedule } from "../../test/scheduleFixtures";
import type { WorkListItem } from "../../types/work";
import ProjectTab from "./ProjectTab";

vi.mock("../Layout", () => ({ useSidebarRefresh: () => ({ isActive: true }) }));

const ZONE = { name: "UTC", offset_seconds: 0 };

const row = (activity: Activity, overrides: Partial<WorkListItem> = {}) =>
	({
		id: "w1",
		type: "story",
		title: "Work",
		status: "active",
		activity,
		updated_at: "2026-10-23T00:00:00Z",
		...overrides,
	}) satisfies WorkListItem;

function renderTab() {
	const handlers = {
		onOpenWorkList: vi.fn(),
		onOpenScheduleList: vi.fn(),
		onOpenAgentRoleList: vi.fn(),
	};
	render(<ProjectTab {...handlers} />);
	return handlers;
}

/** The entry's attention dot, which is `aria-hidden` and has no name of its own. */
function dotOf(name: string): Element | null {
	return screen.getByRole("button", { name }).querySelector(".rounded-full");
}

describe("ProjectTab", () => {
	beforeEach(() => {
		useWorkStore.getState().reset();
		useScheduleStore.getState().reset();
	});

	it("lists Stories, Schedules and Agent Roles, in that order", () => {
		renderTab();

		expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
			"Stories",
			"Schedules",
			"Agent Roles",
		]);
	});

	it("opens each entry's own list", async () => {
		const user = userEvent.setup();
		const handlers = renderTab();

		await user.click(screen.getByRole("button", { name: "Schedules" }));

		expect(handlers.onOpenScheduleList).toHaveBeenCalledOnce();
		expect(handlers.onOpenWorkList).not.toHaveBeenCalled();
	});

	it("dots Schedules, and only Schedules, while a schedule's latest run is waiting on the user", () => {
		useScheduleStore
			.getState()
			.setSchedules(
				[makeSchedule({ last_run: row("needs_permission", { type: "job" }) })],
				ZONE,
			);

		renderTab();

		expect(dotOf("Schedules")).not.toBeNull();
		expect(dotOf("Stories")).toBeNull();
	});

	it("dots Stories, and only Stories, while a story is waiting on the user", () => {
		useWorkStore
			.getState()
			.setWorks([row("running", { unanswered_questions: 1 })]);

		renderTab();

		expect(dotOf("Stories")).not.toBeNull();
		expect(dotOf("Schedules")).toBeNull();
	});

	// A failure needs a person whenever they get to it, not now — the row's edge
	// says it, and a dot would say "someone is waiting" (docs/schedule-ui.md §1).
	it("leaves Schedules undotted for a failed firing alone", () => {
		useScheduleStore.getState().setSchedules(
			[
				makeSchedule({
					last_failure: { at: "2026-10-23T03:00:00Z", error: "boom" },
					last_run: row("stopped", { type: "job", status: "stopped" }),
				}),
			],
			ZONE,
		);

		renderTab();

		expect(dotOf("Schedules")).toBeNull();
	});
});
