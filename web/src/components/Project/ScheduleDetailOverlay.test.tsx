import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { useScheduleStore } from "../../lib/scheduleStore";
import { useWorktreeStore } from "../../lib/worktreeStore";
import { makeRun, makeSchedule } from "../../test/scheduleFixtures";
import type { AgentRole } from "../../types/agentRole";
import type { Schedule, ScheduleRunItem } from "../../types/schedule";
import ScheduleDetailOverlay from "./ScheduleDetailOverlay";

const actions = {
	updateSchedule: vi.fn(),
	deleteSchedule: vi.fn(),
	runSchedule: vi.fn(),
	startWork: vi.fn(),
	stopWork: vi.fn(),
	reopenWork: vi.fn(),
};

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (s: unknown) => unknown) => selector({ actions }),
}));

const mockDetail = vi.fn();
vi.mock("../../hooks/useScheduleDetailSubscription", () => ({
	useScheduleDetailSubscription: (id: string) => mockDetail(id),
}));

const mockWorktrees = vi.fn();
vi.mock("../../hooks/useWorktreeList", () => ({
	useWorktreeList: () => mockWorktrees(),
}));

vi.mock("../ui/MarkdownContent", () => ({
	MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock("../Worktree", () => ({
	WorktreeBadge: () => null,
	useWorktreeBadgeVisible: () => false,
}));

const NOW = new Date("2026-10-23T12:00:00Z");

const jobRole: AgentRole = {
	id: "role-job",
	name: "Auditor",
	role_prompt: "",
	work_type: "job",
	created_at: "2026-10-01T00:00:00Z",
	updated_at: "2026-10-01T00:00:00Z",
};

interface Detail {
	schedule?: Schedule | null;
	runs?: ScheduleRunItem[];
	hasMoreRuns?: boolean;
	loading?: boolean;
	error?: string | null;
	loadMore?: () => Promise<void>;
	isLoadingMore?: boolean;
}

function setDetail({
	schedule = makeSchedule(),
	runs = [],
	hasMoreRuns = false,
	loading = false,
	error = null,
	loadMore = vi.fn().mockResolvedValue(undefined),
	isLoadingMore = false,
}: Detail = {}) {
	mockDetail.mockReturnValue({
		schedule,
		serverZone: { name: "UTC", offset_seconds: 0 },
		runs,
		hasMoreRuns,
		loadMore,
		isLoadingMore,
		loadMoreError: null,
		loading,
		error,
	});
	// The page is the store's too: a schedule the loaded list does not hold
	// has been deleted.
	if (schedule) {
		useScheduleStore
			.getState()
			.setSchedules([schedule], { name: "UTC", offset_seconds: 0 });
	}
}

const nav = {
	onBack: vi.fn(),
	onOpenWorkDetail: vi.fn(),
	onNavigateToSession: vi.fn(),
};

function renderPage() {
	return render(<ScheduleDetailOverlay scheduleId="sched-1" {...nav} />);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	for (const fn of Object.values(actions)) fn.mockResolvedValue(undefined);
	useScheduleStore.getState().reset();
	useAgentRoleStore.setState({
		roles: [jobRole],
		isLoading: false,
		error: null,
	});
	useWorktreeStore.setState({ isGitRepo: true });
	mockWorktrees.mockReturnValue([
		{ name: "", path: "/p", branch: "main", is_main: true },
		{ name: "feature-x", path: "/p/x", branch: "feature-x", is_main: false },
	]);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("ScheduleDetailOverlay", () => {
	describe("not found", () => {
		it("says so when the subscribe is refused", () => {
			setDetail({ schedule: null, error: "schedule not found" });
			renderPage();
			expect(screen.getByText("Schedule not found")).toBeInTheDocument();
		});

		// The detail subscription sends nothing on delete; the list does.
		it("says so once the loaded list no longer holds it", () => {
			setDetail();
			useScheduleStore
				.getState()
				.setSchedules([], { name: "UTC", offset_seconds: 0 });
			renderPage();
			expect(screen.getByText("Schedule not found")).toBeInTheDocument();
		});

		it("does not take a list still loading for a deletion", () => {
			setDetail();
			useScheduleStore.getState().reset();
			renderPage();
			expect(
				screen.getByRole("heading", { name: "Nightly audit" }),
			).toBeInTheDocument();
		});

		it("prints any other failure as it is", () => {
			setDetail({ schedule: null, error: "connection lost" });
			renderPage();
			expect(screen.getByText("connection lost")).toBeInTheDocument();
		});
	});

	describe("the runs", () => {
		it("draws each run as a work row under the Runs heading, dated by when it was made", () => {
			setDetail({
				runs: [
					makeRun({
						id: "run-1",
						title: "Nightly audit",
						created_at: "2026-10-23T09:00:00Z",
						updated_at: "2026-10-23T11:59:00Z",
					}),
				],
			});
			renderPage();

			expect(
				screen.getByRole("heading", { level: 4, name: "Nightly audit" }),
			).toBeInTheDocument();
			expect(screen.getByText("3h ago")).toBeInTheDocument();
		});

		it("opens a run's own page", async () => {
			const user = userEvent.setup();
			setDetail({ runs: [makeRun({ id: "run-1", title: "The run" })] });
			renderPage();

			await user.click(screen.getByRole("button", { name: /^The run — / }));
			expect(nav.onOpenWorkDetail).toHaveBeenCalledWith("run-1");
		});

		it("shows five, then the rest, then reads the next page", async () => {
			const user = userEvent.setup();
			const runs = Array.from({ length: 7 }, (_, i) =>
				makeRun({ id: `run-${i}`, title: `Run ${i}` }),
			);
			const loadMore = vi.fn().mockResolvedValue(undefined);
			setDetail({ runs, hasMoreRuns: true, loadMore });
			renderPage();

			expect(screen.getAllByRole("heading", { level: 4 })).toHaveLength(5);
			await user.click(screen.getByRole("button", { name: "Show more runs" }));
			expect(screen.getAllByRole("heading", { level: 4 })).toHaveLength(7);
			// The loaded rows ran out with more on the server.
			expect(loadMore).toHaveBeenCalledTimes(1);
		});

		it("keeps the focus on Show more runs while a page loads, and ignores presses", async () => {
			const user = userEvent.setup();
			const loadMore = vi.fn().mockResolvedValue(undefined);
			setDetail({
				runs: [makeRun()],
				hasMoreRuns: true,
				loadMore,
				isLoadingMore: true,
			});
			renderPage();

			const more = screen.getByRole("button", { name: "Show more runs" });
			await user.click(more);
			expect(more).toBeEnabled();
			expect(more).toHaveAttribute("aria-busy", "true");
			expect(more).toHaveFocus();
			expect(loadMore).not.toHaveBeenCalled();
		});

		it("offers no more once everything is shown", () => {
			setDetail({ runs: [makeRun()], hasMoreRuns: false });
			renderPage();
			expect(
				screen.queryByRole("button", { name: "Show more runs" }),
			).toBeNull();
		});

		it("says when the first run is due, or how to make one", () => {
			setDetail({ runs: [] });
			const { unmount } = renderPage();
			expect(screen.getByText(/^No runs yet\. The first is due/)).toBeVisible();
			unmount();

			setDetail({
				schedule: makeSchedule({ enabled: false, next_run_at: undefined }),
			});
			renderPage();
			expect(
				screen.getByText("No runs yet. Press Run now to make one."),
			).toBeVisible();
		});
	});

	describe("the notice", () => {
		it("puts a run that could not be started first, with a way to it", async () => {
			const user = userEvent.setup();
			setDetail({
				schedule: makeSchedule({
					last_run_work_id: "run-1",
					last_failure: {
						at: "2026-10-23T03:00:00Z",
						work_id: "run-9",
						error: "agent role not found",
					},
					last_skipped_at: "2026-10-23T04:00:00Z",
				}),
				runs: [makeRun({ id: "run-1", status: "active", activity: "running" })],
			});
			renderPage();

			const notice = screen.getByText(/could not be started/).closest("div");
			if (!notice) throw new Error("no notice");
			expect(within(notice).getByText("agent role not found")).toBeVisible();
			expect(screen.queryByText(/A run is going now/)).toBeNull();
			expect(screen.queryByText(/^Skipped the run at/)).toBeNull();
			await user.click(screen.getByRole("button", { name: "Open the run" }));
			expect(nav.onOpenWorkDetail).toHaveBeenCalledWith("run-9");
		});

		it("says a run is going, and leaves Run now enabled", () => {
			setDetail({
				schedule: makeSchedule({ last_run_work_id: "run-1" }),
				runs: [makeRun({ id: "run-1", status: "active", activity: "running" })],
			});
			renderPage();
			expect(screen.getByText(/A run is going now/)).toBeVisible();
			expect(screen.getByRole("button", { name: "Run now" })).toBeEnabled();
		});

		it("says a firing was skipped only when it is newer than the last run", () => {
			setDetail({
				schedule: makeSchedule({
					last_run_at: "2026-10-23T03:00:00Z",
					last_skipped_at: "2026-10-23T04:00:00Z",
				}),
			});
			const { unmount } = renderPage();
			expect(screen.getByText(/^Skipped the run at/)).toBeVisible();
			unmount();

			setDetail({
				schedule: makeSchedule({
					last_run_at: "2026-10-23T05:00:00Z",
					last_skipped_at: "2026-10-23T04:00:00Z",
				}),
			});
			renderPage();
			expect(screen.queryByText(/^Skipped the run at/)).toBeNull();
		});
	});

	describe("the period", () => {
		// Check 5: a spelling the presets would not write is still the stored one.
		it("sends nothing for a period saved untouched", async () => {
			const user = userEvent.setup();
			setDetail({ schedule: makeSchedule({ cron: "0 9 * * MON-FRI" }) });
			renderPage();

			expect(screen.getByText("Weekdays at 09:00")).toBeVisible();
			await user.click(screen.getByRole("button", { name: "Edit period" }));
			await user.click(screen.getByRole("button", { name: "Save" }));

			expect(actions.updateSchedule).not.toHaveBeenCalled();
			expect(screen.getByRole("button", { name: "Edit period" })).toBeVisible();
		});

		it("sends the canonical cron once the period is edited", async () => {
			const user = userEvent.setup();
			setDetail({ schedule: makeSchedule({ cron: "0 9 * * MON-FRI" }) });
			renderPage();

			await user.click(screen.getByRole("button", { name: "Edit period" }));
			await user.click(screen.getByRole("button", { name: "Sat" }));
			await user.click(screen.getByRole("button", { name: "Save" }));

			expect(actions.updateSchedule).toHaveBeenCalledWith({
				id: "sched-1",
				cron: "0 9 * * 1,2,3,4,5,6",
			});
		});

		it("keeps the editor open with the server's refusal", async () => {
			const user = userEvent.setup();
			actions.updateSchedule.mockRejectedValue(
				new Error('minute field "61": 61 is out of range 0-59'),
			);
			setDetail({ schedule: makeSchedule({ cron: "0 9 * * *" }) });
			renderPage();

			await user.click(screen.getByRole("button", { name: "Edit period" }));
			await user.click(screen.getByRole("button", { name: "Custom" }));
			const text = screen.getByRole("textbox", { name: "Cron expression" });
			await user.clear(text);
			await user.type(text, "61 9 * * *");
			await user.click(screen.getByRole("button", { name: "Save" }));

			expect(await screen.findByRole("alert")).toHaveTextContent(
				"61 is out of range",
			);
			expect(text).toBeVisible();
		});
	});

	describe("the settings", () => {
		it("says a deleted role will fail the runs", () => {
			setDetail({ schedule: makeSchedule({ agent_role_id: "gone" }) });
			renderPage();
			expect(
				screen.getByText(/This role has been deleted\. Runs will fail/),
			).toBeVisible();
		});

		it("says a role that no longer takes jobs is kept", () => {
			useAgentRoleStore.setState({
				roles: [{ ...jobRole, work_type: "story" }],
			});
			setDetail();
			renderPage();
			expect(
				screen.getByText(
					"Auditor only takes stories. Runs keep using it until you change it.",
				),
			).toBeVisible();
		});

		it("names a deleted worktree as deleted", () => {
			setDetail({ schedule: makeSchedule({ worktree: "old" }) });
			renderPage();
			expect(
				screen.getByRole("option", { name: "old (deleted)" }),
			).toBeInTheDocument();
			expect(
				screen.getByText(
					"Runs will fail until you pick a worktree that exists.",
				),
			).toBeVisible();
		});

		it("applies a worktree on change", async () => {
			const user = userEvent.setup();
			setDetail();
			renderPage();
			await user.selectOptions(
				screen.getByRole("combobox", { name: "Worktree" }),
				"feature-x",
			);
			expect(actions.updateSchedule).toHaveBeenCalledWith({
				id: "sched-1",
				worktree: "feature-x",
			});
		});

		it("offers no worktree outside a git repository", () => {
			useWorktreeStore.setState({ isGitRepo: false });
			setDetail();
			renderPage();
			expect(screen.queryByRole("combobox", { name: "Worktree" })).toBeNull();
		});
	});

	describe("Run now and Delete", () => {
		it("runs and stays on the page", async () => {
			const user = userEvent.setup();
			setDetail();
			renderPage();
			await user.click(screen.getByRole("button", { name: "Run now" }));
			expect(actions.runSchedule).toHaveBeenCalledWith("sched-1");
			expect(nav.onBack).not.toHaveBeenCalled();
			expect(nav.onOpenWorkDetail).not.toHaveBeenCalled();
		});

		it("prints a refused run in the bar", async () => {
			const user = userEvent.setup();
			actions.runSchedule.mockRejectedValue(
				new Error("previous run is still active"),
			);
			setDetail();
			renderPage();
			await user.click(screen.getByRole("button", { name: "Run now" }));
			expect(await screen.findByRole("alert")).toHaveTextContent(
				"previous run is still active",
			);
		});

		it("deletes after confirming, and goes back to the schedules", async () => {
			const user = userEvent.setup();
			setDetail();
			renderPage();
			await user.click(screen.getByRole("button", { name: "Delete schedule" }));
			const dialog = screen.getByRole("dialog");
			expect(dialog).toHaveTextContent("a run in progress keeps going");
			await user.click(within(dialog).getByRole("button", { name: "Delete" }));
			expect(actions.deleteSchedule).toHaveBeenCalledWith("sched-1");
			expect(nav.onBack).toHaveBeenCalled();
		});

		it("stays on the page and says why when the delete is refused", async () => {
			const user = userEvent.setup();
			actions.deleteSchedule.mockRejectedValue(new Error("disk full"));
			setDetail();
			renderPage();
			await user.click(screen.getByRole("button", { name: "Delete schedule" }));
			await user.click(
				within(screen.getByRole("dialog")).getByRole("button", {
					name: "Delete",
				}),
			);
			expect(await screen.findByRole("alert")).toHaveTextContent(
				"Failed to delete: disk full",
			);
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
			expect(nav.onBack).not.toHaveBeenCalled();
		});
	});
});

describe("ScheduleDetailOverlay, more of the page", () => {
	it("says a run that could not be made, with nothing to open", () => {
		setDetail({
			schedule: makeSchedule({
				last_failure: {
					at: "2026-10-23T03:00:00Z",
					error: "create run: invalid work",
				},
			}),
		});
		renderPage();
		expect(screen.getByText(/could not be made\.$/)).toBeVisible();
		expect(screen.queryByRole("button", { name: "Open the run" })).toBeNull();
	});

	it("does not call runs that were deleted none yet", () => {
		setDetail({
			schedule: makeSchedule({ last_run_at: "2026-10-22T03:00:00Z" }),
			runs: [],
		});
		renderPage();
		expect(screen.getByText("Its runs have been deleted.")).toBeVisible();
	});

	it("saves the title", async () => {
		const user = userEvent.setup();
		setDetail();
		renderPage();
		await user.click(screen.getByRole("button", { name: "Edit title" }));
		const input = screen.getByRole("textbox", { name: "Title" });
		await user.clear(input);
		await user.type(input, "Weekly audit{Enter}");
		expect(actions.updateSchedule).toHaveBeenCalledWith({
			id: "sched-1",
			title: "Weekly audit",
		});
	});

	it("saves the prompt", async () => {
		const user = userEvent.setup();
		setDetail();
		renderPage();
		await user.click(screen.getByRole("button", { name: "Edit prompt" }));
		const text = screen.getByRole("textbox", { name: "Prompt" });
		await user.clear(text);
		await user.type(text, "Audit everything.");
		await user.click(screen.getByRole("button", { name: "Save" }));
		expect(actions.updateSchedule).toHaveBeenCalledWith({
			id: "sched-1",
			prompt: "Audit everything.",
		});
	});

	it("applies a role on change", async () => {
		const user = userEvent.setup();
		useAgentRoleStore.setState({
			roles: [jobRole, { ...jobRole, id: "role-2", name: "Janitor" }],
		});
		setDetail();
		renderPage();
		await user.selectOptions(
			screen.getByRole("combobox", { name: "Role" }),
			"role-2",
		);
		expect(actions.updateSchedule).toHaveBeenCalledWith({
			id: "sched-1",
			agent_role_id: "role-2",
		});
	});

	// The guards exist for these: a list that has not arrived says nothing.
	it("says nothing about the role or worktree while their lists load", () => {
		useAgentRoleStore.setState({ roles: [], isLoading: true });
		mockWorktrees.mockReturnValue([]);
		setDetail({
			schedule: makeSchedule({ agent_role_id: "gone", worktree: "old" }),
		});
		renderPage();
		expect(screen.queryByText(/This role has been deleted/)).toBeNull();
		expect(screen.queryByText(/pick a worktree that exists/)).toBeNull();
		expect(screen.getByRole("option", { name: "old" })).toBeInTheDocument();
	});

	it("says nothing about a deleted role while the role list has failed", () => {
		useAgentRoleStore.setState({ roles: [], isLoading: false, error: "boom" });
		setDetail({ schedule: makeSchedule({ agent_role_id: "gone" }) });
		renderPage();
		expect(screen.queryByText(/This role has been deleted/)).toBeNull();
	});

	it("turns the schedule off from its switch, and moves only with the record", async () => {
		const user = userEvent.setup();
		setDetail();
		renderPage();
		const toggle = screen.getByRole("switch", {
			name: 'Run "Nightly audit" on schedule',
		});
		await user.click(toggle);
		expect(actions.updateSchedule).toHaveBeenCalledWith({
			id: "sched-1",
			enabled: false,
		});
		expect(toggle).toBeChecked();
	});

	it("holds the period still while it saves", async () => {
		const user = userEvent.setup();
		actions.updateSchedule.mockReturnValue(new Promise(() => {}));
		setDetail({ schedule: makeSchedule({ cron: "0 9 * * *" }) });
		renderPage();
		await user.click(screen.getByRole("button", { name: "Edit period" }));
		await user.click(screen.getByRole("button", { name: "Weekly" }));
		await user.click(screen.getByRole("button", { name: "Save" }));
		expect(screen.getByRole("button", { name: "Mon" })).toBeDisabled();
	});
});
