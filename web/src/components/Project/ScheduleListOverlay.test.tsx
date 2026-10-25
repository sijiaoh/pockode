import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScheduleStore } from "../../lib/scheduleStore";
import { makeSchedule } from "../../test/scheduleFixtures";
import type { ScheduleListItem } from "../../types/schedule";
import ScheduleListOverlay from "./ScheduleListOverlay";

const updateSchedule = vi.fn();

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (s: unknown) => unknown) =>
		selector({ actions: { updateSchedule } }),
}));

let deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
vi.mock("../../hooks/useDeviceTimeZone", () => ({
	useDeviceTimeZone: () => deviceZone,
}));

vi.mock("../../hooks/useRouteState", () => ({
	useRouteState: () => ({ worktree: "", sessionId: null }),
}));

// The sheet has its own tests; here it stands for "the create flow answered
// with an id", which is the wiring this screen owns.
vi.mock("./CreateScheduleSheet", () => ({
	default: ({ onCreated }: { onCreated: (id: string) => void }) => (
		<button type="button" onClick={() => onCreated("new-schedule")}>
			Pretend to create
		</button>
	),
}));

const NOW = new Date("2026-10-23T12:00:00Z");

function setSchedules(schedules: ScheduleListItem[]) {
	useScheduleStore.getState().setSchedules(schedules);
}

const onOpenScheduleDetail = vi.fn();

function renderOverlay() {
	return render(
		<ScheduleListOverlay
			onBack={vi.fn()}
			onOpenScheduleDetail={onOpenScheduleDetail}
		/>,
	);
}

/** The card a title belongs to: the title button's nearest positioned box. */
const card = (title: string) => {
	const el = screen
		.getByRole("button", { name: title })
		.closest("div.relative") as HTMLElement | null;
	if (!el) throw new Error(`no card for ${title}`);
	return el;
};

beforeEach(() => {
	vi.clearAllMocks();
	// Only the clock is faked: userEvent deadlocks under frozen timers.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	useScheduleStore.getState().reset();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("ScheduleListOverlay", () => {
	it("lists newest made first, whatever is on or off", () => {
		setSchedules([
			makeSchedule({
				id: "a",
				title: "Oldest",
				created_at: "2026-10-01T00:00:00Z",
			}),
			makeSchedule({
				id: "b",
				title: "Newest",
				enabled: false,
				created_at: "2026-10-03T00:00:00Z",
			}),
			makeSchedule({
				id: "c",
				title: "Middle",
				created_at: "2026-10-02T00:00:00Z",
			}),
		]);
		renderOverlay();

		const titles = screen
			.getAllByRole("heading", { level: 2 })
			.map((h) => h.textContent);
		expect(titles).toEqual(["Newest", "Middle", "Oldest"]);
	});

	it("says what a schedule is and when it fires next", () => {
		setSchedules([
			makeSchedule({
				id: "a",
				title: "On",
				cron: "0 3 * * *",
				next_run_at: "2026-10-23T17:00:00Z",
			}),
			makeSchedule({
				id: "b",
				title: "Paused",
				cron: "*/15 9-17 * * 1-5",
				enabled: false,
				next_run_at: undefined,
				created_at: "2026-09-01T00:00:00Z",
			}),
		]);
		renderOverlay();

		expect(within(card("On")).getByText("Daily at 03:00")).toBeInTheDocument();
		expect(within(card("On")).getByText("Next in 5h")).toBeInTheDocument();
		// A cron no preset matches is shown as written, the expression in mono.
		expect(within(card("Paused")).getByText("*/15 9-17 * * 1-5")).toHaveClass(
			"font-mono",
		);
		expect(within(card("Paused")).getByText("Off")).toBeInTheDocument();
	});

	it("names the schedule's zone beside the period only when the device is in another", () => {
		const real = deviceZone;
		deviceZone = "Europe/London";
		try {
			setSchedules([
				makeSchedule({ id: "a", title: "Audit", time_zone: "Asia/Tokyo" }),
				makeSchedule({
					id: "b",
					title: "Custom",
					cron: "0 9 1 * *",
					time_zone: "Asia/Tokyo",
				}),
				makeSchedule({ id: "c", title: "Home", time_zone: "Europe/London" }),
			]);
			renderOverlay();
			expect(card("Audit")).toHaveTextContent("Daily at 03:00 (Tokyo)");
			// The label in the line's own font, not the expression's mono.
			expect(within(card("Custom")).getByText("(Tokyo)")).not.toHaveClass(
				"font-mono",
			);
			expect(card("Home")).toHaveTextContent("Daily at 03:00");
			expect(card("Home")).not.toHaveTextContent("(");
		} finally {
			deviceZone = real;
		}
	});

	it.each<[string, Partial<ScheduleListItem>, RegExp]>([
		[
			"a failure, over the run it outlived",
			{
				last_failure: { at: "2026-10-20T03:00:00Z", error: "create run: boom" },
				last_run_at: "2026-10-19T03:00:00Z",
				last_run: {
					id: "run",
					type: "job",
					title: "Audit",
					status: "active",
					activity: "running",
					updated_at: "2026-10-19T03:00:00Z",
				},
			},
			/Last run failed·3d ago/,
		],
		[
			"the latest run's activity, its questions and age",
			{
				last_run_at: "2026-10-23T10:00:00Z",
				last_run: {
					id: "run",
					type: "job",
					title: "Audit",
					status: "active",
					activity: "running",
					unanswered_questions: 1,
					updated_at: "2026-10-23T10:00:00Z",
				},
			},
			/Running·1 to answer·2h ago/,
		],
		[
			"a latest run that was deleted",
			{ last_run_at: "2026-10-20T03:00:00Z" },
			/Latest run deleted·3d ago/,
		],
		["a schedule that never ran", {}, /No runs yet/],
	])("line 3 reads %s", (_, overrides, line) => {
		setSchedules([makeSchedule({ title: "Audit", ...overrides })]);
		renderOverlay();

		expect(card("Audit").textContent).toMatch(line);
	});

	it.each<[string, Partial<ScheduleListItem>, string]>([
		[
			"error while a failure is set, over the run's own",
			{
				last_failure: { at: "2026-10-20T03:00:00Z", error: "boom" },
				last_run: {
					id: "run",
					type: "job",
					title: "Audit",
					status: "active",
					activity: "needs_permission",
					updated_at: "2026-10-19T03:00:00Z",
				},
			},
			"border-l-th-error",
		],
		[
			"the latest run's edge otherwise",
			{
				last_run: {
					id: "run",
					type: "job",
					title: "Audit",
					status: "active",
					activity: "needs_permission",
					updated_at: "2026-10-19T03:00:00Z",
				},
			},
			"border-l-th-warning",
		],
		["neutral with neither", {}, "border-l-th-border"],
	])("the edge is %s", (_, overrides, edge) => {
		setSchedules([makeSchedule({ title: "Audit", ...overrides })]);
		renderOverlay();
		expect(card("Audit")).toHaveClass(edge);
	});

	it("opens a schedule from its card", async () => {
		const user = userEvent.setup();
		setSchedules([makeSchedule({ id: "s1", title: "Audit" })]);
		renderOverlay();

		await user.click(screen.getByRole("button", { name: "Audit" }));
		expect(onOpenScheduleDetail).toHaveBeenCalledWith("s1");
	});

	describe("the switch", () => {
		const theSwitch = () =>
			screen.getByRole("switch", { name: 'Run "Audit" on schedule' });

		it("asks the server and shows what it stored, not the tap", async () => {
			const user = userEvent.setup();
			let resolve: () => void = () => {};
			updateSchedule.mockReturnValue(
				new Promise<void>((r) => {
					resolve = r;
				}),
			);
			setSchedules([makeSchedule({ id: "s1", title: "Audit" })]);
			renderOverlay();

			await user.click(theSwitch());
			expect(updateSchedule).toHaveBeenCalledWith({ id: "s1", enabled: false });
			expect(theSwitch()).toHaveAttribute("aria-checked", "true");
			expect(theSwitch()).toHaveAttribute("aria-busy", "true");

			// Pressed again in flight: ignored.
			await user.click(theSwitch());
			expect(updateSchedule).toHaveBeenCalledTimes(1);

			await act(async () => resolve());
			expect(theSwitch()).toHaveAttribute("aria-checked", "true");

			act(() =>
				useScheduleStore
					.getState()
					.updateSchedules((old) => old.map((s) => ({ ...s, enabled: false }))),
			);
			expect(theSwitch()).toHaveAttribute("aria-checked", "false");
		});

		it("leaves a refused change where it was, with the server's reason", async () => {
			const user = userEvent.setup();
			updateSchedule.mockRejectedValue(new Error("schedule not found"));
			setSchedules([makeSchedule({ title: "Audit" })]);
			renderOverlay();

			await user.click(theSwitch());

			const alert = await screen.findByRole("alert");
			expect(alert).toHaveTextContent("schedule not found");
			expect(theSwitch()).toHaveAttribute("aria-checked", "true");
			expect(theSwitch()).toHaveAccessibleDescription("schedule not found");

			// A retry clears it while the request is in flight.
			updateSchedule.mockReturnValue(new Promise<void>(() => {}));
			await user.click(theSwitch());
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		});

		it("drops a refusal once the stored value has moved, in either order", async () => {
			const user = userEvent.setup();
			let reject: (err: Error) => void = () => {};
			updateSchedule.mockReturnValue(
				new Promise<void>((_, r) => {
					reject = r;
				}),
			);
			setSchedules([makeSchedule({ title: "Audit" })]);
			renderOverlay();

			await user.click(theSwitch());
			// The notification lands first, then the refusal.
			act(() =>
				useScheduleStore
					.getState()
					.updateSchedules((old) => old.map((s) => ({ ...s, enabled: false }))),
			);
			await act(async () => reject(new Error("too late")));
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		});

		it("clears a refusal when the value changes under it", async () => {
			const user = userEvent.setup();
			updateSchedule.mockRejectedValue(new Error("schedule not found"));
			setSchedules([makeSchedule({ title: "Audit" })]);
			renderOverlay();
			await user.click(theSwitch());
			await screen.findByRole("alert");

			// The value changing under it clears the message.
			act(() =>
				useScheduleStore
					.getState()
					.updateSchedules((old) => old.map((s) => ({ ...s, enabled: false }))),
			);
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		});
	});

	it("says what a schedule is when there are none", () => {
		setSchedules([]);
		renderOverlay();
		expect(screen.getByText("No schedules yet.")).toBeInTheDocument();
	});

	it("lands on a schedule it created", async () => {
		const user = userEvent.setup();
		setSchedules([]);
		renderOverlay();

		await user.click(screen.getByRole("button", { name: "New Schedule" }));
		await user.click(screen.getByRole("button", { name: "Pretend to create" }));
		expect(onOpenScheduleDetail).toHaveBeenCalledWith("new-schedule");
		expect(
			screen.queryByRole("button", { name: "Pretend to create" }),
		).not.toBeInTheDocument();
	});

	it("offers New Schedule while the list is still loading", () => {
		renderOverlay();
		expect(
			screen.getByRole("button", { name: "New Schedule" }),
		).toBeInTheDocument();
	});
});
