import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkStore } from "../../lib/workStore";
import type {
	PermissionStatus,
	SessionTurn,
	TurnBlocker,
	WatchedStory,
} from "../../types/message";
import AttentionStrip, { type PermissionEntry } from "./AttentionStrip";
import { ARM_MS } from "./SendStopSlot";

function turn(
	phase: SessionTurn["phase"],
	blockers?: TurnBlocker[],
): SessionTurn {
	return {
		phase,
		open: phase !== "idle",
		since: "2026-01-02T14:02:00Z",
		blockers,
	};
}

const permission: TurnBlocker = {
	kind: "permission",
	request_id: "p1",
	raised_at: "2026-01-02T14:02:00Z",
};
const background: TurnBlocker = {
	kind: "background",
	raised_at: "2026-01-02T14:02:00Z",
};

function unanswered(n: number) {
	return Array.from({ length: n }, (_, i) => ({
		request_id: `u${i}`,
		header: "Database",
		question: "Which database should I use?",
		options: [],
		multi_select: false,
		asked_at: "2026-01-02T14:02:00Z",
	}));
}

describe("AttentionStrip", () => {
	it.each<[SessionTurn["phase"], TurnBlocker[] | undefined]>([
		["idle", undefined],
		["running", undefined],
	])("says nothing while the turn is %s", (phase, blockers) => {
		const { container } = render(
			<AttentionStrip turn={turn(phase, blockers)} onJumpToRequest={vi.fn()} />,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("jumps to the permission request holding the turn up", async () => {
		const user = userEvent.setup();
		const onJump = vi.fn();
		render(
			<AttentionStrip
				turn={turn("blocked", [permission])}
				onJumpToRequest={onJump}
			/>,
		);

		expect(
			screen.getByText(/Waiting for your permission\./),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Jump to request" }));
		expect(onJump).toHaveBeenCalledWith("p1");
	});

	// Permission outranks background — the same precedence the activity derivation
	// uses, and for the same reason: one of them has something to press.
	it("speaks for the permission when a background wait is live too", async () => {
		const user = userEvent.setup();
		const onJump = vi.fn();
		render(
			<AttentionStrip
				turn={turn("blocked", [background, permission])}
				onJumpToRequest={onJump}
			/>,
		);

		expect(
			screen.getByText(/Waiting for your permission\./),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Jump to request" }));
		expect(onJump).toHaveBeenCalledWith("p1");
	});

	// The two things a user who has waited an hour needs told before they reach
	// for Stop.
	it("explains a background wait on request", async () => {
		const user = userEvent.setup();
		render(
			<AttentionStrip
				turn={turn("blocked", [background])}
				onJumpToRequest={vi.fn()}
			/>,
		);

		expect(
			screen.getByText(/nothing to answer/, { exact: false }),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Details" }));

		const detail = screen.getByText(/resumes on its own/, { exact: false });
		expect(detail).toHaveTextContent(
			"Stopping ends the turn and loses the tasks.",
		);
		// Stated as a time, never as a countdown to a lease the user cannot change.
		expect(detail.textContent).toMatch(/since \d{1,2}:\d{2}/);
	});

	describe("the unanswered questions row", () => {
		it("counts them and offers the one way to answer", async () => {
			const user = userEvent.setup();
			const onAnswer = vi.fn();
			render(
				<AttentionStrip
					turn={{ ...turn("idle"), unanswered: unanswered(2) }}
					onJumpToRequest={vi.fn()}
					onAnswer={onAnswer}
				/>,
			);

			expect(
				screen.getByText("2 questions are waiting for your answer."),
			).toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: "Answer" }));
			expect(onAnswer).toHaveBeenCalled();
		});

		// Sending is not refused while a posted question is open: the agent may
		// be running, and a typed message is an ordinary message. A sentence
		// about sending here would be inventing a restriction to explain.
		it("says nothing about sending", () => {
			render(
				<AttentionStrip
					turn={{ ...turn("idle"), unanswered: unanswered(1) }}
					onJumpToRequest={vi.fn()}
					onAnswer={vi.fn()}
				/>,
			);
			expect(
				screen.getByText("1 question is waiting for your answer."),
			).toBeInTheDocument();
			expect(screen.queryByText(/before sending/)).not.toBeInTheDocument();
		});

		// No "nothing to answer", no empty frame.
		it("does not exist at zero", () => {
			const { container } = render(
				<AttentionStrip
					turn={{ ...turn("idle"), unanswered: [] }}
					onJumpToRequest={vi.fn()}
					onAnswer={vi.fn()}
				/>,
			);
			expect(container).toBeEmptyDOMElement();
		});

		// Permission is the only row the composer is disabled under, and the only
		// state in which the server refuses the answer message itself.
		it("yields to a permission request", () => {
			render(
				<AttentionStrip
					turn={{
						...turn("blocked", [permission]),
						unanswered: unanswered(1),
					}}
					onJumpToRequest={vi.fn()}
					onAnswer={vi.fn()}
				/>,
			);
			expect(
				screen.getByText(/Waiting for your permission\./),
			).toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: "Answer" }),
			).not.toBeInTheDocument();
		});

		// The panel is that sentence already, said in full. The row comes back
		// intact the moment the panel is closed, which is what makes its Answer
		// button the one way back in.
		it("stands down while the answer panel is up, and returns when it closes", () => {
			const { rerender } = render(
				<AttentionStrip
					turn={{ ...turn("idle"), unanswered: unanswered(2) }}
					onJumpToRequest={vi.fn()}
					onAnswer={vi.fn()}
					answerPanelOpen
				/>,
			);
			expect(
				screen.queryByText("2 questions are waiting for your answer."),
			).not.toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: "Answer" }),
			).not.toBeInTheDocument();

			rerender(
				<AttentionStrip
					turn={{ ...turn("idle"), unanswered: unanswered(2) }}
					onJumpToRequest={vi.fn()}
					onAnswer={vi.fn()}
					answerPanelOpen={false}
				/>,
			);
			expect(
				screen.getByText("2 questions are waiting for your answer."),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Answer" }),
			).toBeInTheDocument();
		});

		// Standing down is not a blank frame held open for the panel: the whole
		// strip goes, and the composer moves up by that one line.
		it("leaves no empty frame behind when it stands down", () => {
			const { container } = render(
				<AttentionStrip
					turn={{ ...turn("idle"), unanswered: unanswered(1) }}
					onJumpToRequest={vi.fn()}
					onAnswer={vi.fn()}
					answerPanelOpen
				/>,
			);
			expect(container).toBeEmptyDOMElement();
		});

		// The panel says nothing about a permission request, so the row that does
		// is unaffected by it being up.
		it("still speaks for a permission request while the panel is up", () => {
			render(
				<AttentionStrip
					turn={{
						...turn("blocked", [permission]),
						unanswered: unanswered(1),
					}}
					onJumpToRequest={vi.fn()}
					onAnswer={vi.fn()}
					answerPanelOpen
				/>,
			);
			expect(
				screen.getByText(/Waiting for your permission\./),
			).toBeInTheDocument();
		});

		// It is the one row with something to *do* that is not already on screen.
		it("outranks the send receipt", () => {
			render(
				<AttentionStrip
					turn={{ ...turn("running"), unanswered: unanswered(1) }}
					onJumpToRequest={vi.fn()}
					onAnswer={vi.fn()}
					sendPending
				/>,
			);
			expect(
				screen.getByRole("button", { name: "Answer" }),
			).toBeInTheDocument();
		});
	});

	// A disabled Send with no reason on screen is a silent failure. The strip is
	// the only place that reason can go, so the sentence is part of the refusal,
	// not decoration.
	it("says why sending is refused during a permission request", () => {
		render(
			<AttentionStrip
				turn={turn("blocked", [permission])}
				onJumpToRequest={vi.fn()}
			/>,
		);

		expect(
			screen.getByText(/Answer above or Stop before sending\./),
		).toBeInTheDocument();
	});

	// The receipt for a message sent into a running turn the agent has yet to
	// read. For that stretch the reply above simply keeps growing and nothing
	// appears under the message, so a send that landed and a send that vanished
	// look identical. The read point ends it by putting a bubble under the
	// message, which is what clears `sendPending` upstream.
	describe("a message the agent has not read yet", () => {
		it("is acknowledged while the turn runs on", () => {
			render(
				<AttentionStrip
					turn={turn("running")}
					onJumpToRequest={vi.fn()}
					sendPending
				/>,
			);

			expect(
				screen.getByText("Sent — the agent has not read it yet."),
			).toBeInTheDocument();
		});

		// Sending *is* allowed during a background wait, so this is the one state
		// where the receipt has to outrank a blocker — otherwise a message lands
		// there with no acknowledgement at all.
		it("outranks a background wait", () => {
			render(
				<AttentionStrip
					turn={turn("blocked", [background])}
					onJumpToRequest={vi.fn()}
					sendPending
				/>,
			);

			expect(
				screen.getByText("Sent — the agent has not read it yet."),
			).toBeInTheDocument();
			expect(screen.queryByText(/nothing to answer/)).not.toBeInTheDocument();
		});

		// A prompt is what the session is stuck on and what sending is refused
		// for; the receipt can wait. Reachable because a request can be raised
		// after the message went in.
		it("yields to a permission request", () => {
			render(
				<AttentionStrip
					turn={turn("blocked", [permission])}
					onJumpToRequest={vi.fn()}
					sendPending
				/>,
			);

			expect(
				screen.queryByText("Sent — the agent has not read it yet."),
			).not.toBeInTheDocument();
			expect(
				screen.getByText(/Answer above or Stop before sending\./),
			).toBeInTheDocument();
		});
	});

	// There is no per-task kill: the model gives the host no way to end one task
	// without ending the turn, so the strip must not offer one.
	it("offers nothing to press against the task itself", () => {
		render(
			<AttentionStrip
				turn={turn("blocked", [background])}
				onJumpToRequest={vi.fn()}
			/>,
		);
		expect(screen.getAllByRole("button")).toHaveLength(1);
	});

	// The row a pending card makes of itself: the request on one line and the
	// two answers that need nothing more (docs/lifecycle-ui.md §2.2).
	describe("answering a permission request from the strip", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		function entry(
			requestId: string,
			status: PermissionStatus = "pending",
			toolName = "Bash",
			toolInput: unknown = { command: "rm -rf build/ && npm run build" },
		): PermissionEntry {
			return {
				request: {
					requestId,
					toolName,
					toolInput,
					toolUseId: `t-${requestId}`,
				},
				status,
			};
		}

		function blockers(...ids: string[]): TurnBlocker[] {
			return ids.map((request_id) => ({ ...permission, request_id }));
		}

		const armed = (name: string) =>
			screen.getByRole("button", { name }).closest("[inert]") === null;

		it("says the request in one line and answers it the card's way", () => {
			vi.useFakeTimers();
			const onRespond = vi.fn();
			const entries = [entry("p1")];
			render(
				<AttentionStrip
					turn={turn("blocked", blockers("p1"))}
					onJumpToRequest={vi.fn()}
					permissionRequests={entries}
					onPermissionRespond={onRespond}
				/>,
			);

			const row = screen.getByRole("group", { name: "Permission request" });
			expect(row).toHaveTextContent("Bash");
			expect(row).toHaveTextContent("rm -rf build/ && npm run build");
			expect(screen.queryByText(/Waiting for your permission/)).toBeNull();
			// Adding rules is decided on the card, where the rules are spelled out.
			expect(screen.queryByRole("button", { name: /Always/ })).toBeNull();

			act(() => vi.advanceTimersByTime(ARM_MS));
			fireEvent.click(screen.getByRole("button", { name: "Allow" }));
			expect(onRespond).toHaveBeenCalledWith(entries[0].request, "allow");
			fireEvent.click(screen.getByRole("button", { name: "Deny" }));
			expect(onRespond).toHaveBeenCalledWith(entries[0].request, "deny");
		});

		// Answering one puts the next in the same place, so a second tap would
		// approve a command nobody read.
		it("holds the answers for a moment each time a new request takes the row", () => {
			vi.useFakeTimers();
			const props = {
				onJumpToRequest: vi.fn(),
				onPermissionRespond: vi.fn(),
			};
			const { rerender } = render(
				<AttentionStrip
					{...props}
					turn={turn("blocked", blockers("p1", "p2"))}
					permissionRequests={[entry("p1"), entry("p2")]}
				/>,
			);
			expect(armed("Allow")).toBe(false);
			expect(armed("Deny")).toBe(false);
			act(() => vi.advanceTimersByTime(ARM_MS));
			expect(armed("Allow")).toBe(true);

			rerender(
				<AttentionStrip
					{...props}
					turn={turn("blocked", blockers("p1", "p2"))}
					permissionRequests={[entry("p1", "allowed"), entry("p2")]}
				/>,
			);
			expect(armed("Allow")).toBe(false);
			act(() => vi.advanceTimersByTime(ARM_MS));
			expect(armed("Allow")).toBe(true);
		});

		it("jumps to the card from the summary", async () => {
			const user = userEvent.setup();
			const onJump = vi.fn();
			render(
				<AttentionStrip
					turn={turn("blocked", blockers("p1"))}
					onJumpToRequest={onJump}
					permissionRequests={[entry("p1")]}
					onPermissionRespond={vi.fn()}
				/>,
			);

			await user.click(
				screen.getByRole("button", { name: /^Show permission request: Bash/ }),
			);
			expect(onJump).toHaveBeenCalledWith("p1");
		});

		// With the caret in the composer or the answer panel, a press that moved
		// focus would drop the keyboard or bring the composer back mid-press.
		it.each(["Allow", "Deny"])("leaves focus where it is on %s", (name) => {
			render(
				<AttentionStrip
					turn={turn("blocked", blockers("p1"))}
					onJumpToRequest={vi.fn()}
					permissionRequests={[entry("p1")]}
					onPermissionRespond={vi.fn()}
				/>,
			);
			expect(fireEvent.mouseDown(screen.getByRole("button", { name }))).toBe(
				false,
			);
		});

		it("speaks for the oldest pending request and counts the rest", () => {
			render(
				<AttentionStrip
					turn={turn("blocked", blockers("p1", "p2", "p3"))}
					onJumpToRequest={vi.fn()}
					permissionRequests={[
						entry("p1", "allowed"),
						entry("p2", "pending", "Write", { file_path: "/a/notes.md" }),
						entry("p3"),
					]}
					onPermissionRespond={vi.fn()}
				/>,
			);

			const summary = screen.getByRole("button", {
				name: /^Show permission request: Write/,
			});
			expect(summary).toHaveTextContent("+1");
			expect(summary).toHaveAccessibleName(
				expect.stringContaining("1 more permission request waiting"),
			);
		});

		// Between the press and the server taking the blocker down, the row holds
		// still as the press's receipt rather than flashing another row.
		it("shows the answer as a receipt until the blocker goes", () => {
			render(
				<AttentionStrip
					turn={turn("blocked", blockers("p1"))}
					onJumpToRequest={vi.fn()}
					permissionRequests={[entry("p1", "denied")]}
					onPermissionRespond={vi.fn()}
					sendPending
				/>,
			);

			expect(screen.getByText("Denied")).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
			expect(screen.queryByText(/Sent — /)).toBeNull();
		});

		// The answer was given here, so its refusal is said here; the card has
		// already gone back to pending, so it can be answered again.
		it("says a refused answer on the row and keeps the answers", () => {
			render(
				<AttentionStrip
					turn={turn("blocked", blockers("p1"))}
					onJumpToRequest={vi.fn()}
					permissionRequests={[entry("p1")]}
					onPermissionRespond={vi.fn()}
					promptError={{ requestId: "p1", message: "The process has ended." }}
				/>,
			);

			expect(screen.getByText("The process has ended.")).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
			// Allow is still live, so what it approves stays beside it.
			expect(
				screen.getByRole("button", {
					name: /^Show permission request: Bash .*answer refused: The process has ended\.$/,
				}),
			).toHaveTextContent("Bash");
		});

		// A Claude deny interrupts the turn, so the requests behind it are about
		// to expire: offering their answers would only collect refusals.
		it("holds a denial's receipt rather than handing the row on", () => {
			render(
				<AttentionStrip
					turn={turn("blocked", blockers("p1", "p2"))}
					onJumpToRequest={vi.fn()}
					permissionRequests={[entry("p1", "denied"), entry("p2")]}
					onPermissionRespond={vi.fn()}
				/>,
			);

			expect(screen.getByRole("status")).toHaveTextContent("Denied");
			expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
		});

		it("hands the row to the next request once an allowed one is answered", () => {
			render(
				<AttentionStrip
					turn={turn("blocked", blockers("p1", "p2"))}
					onJumpToRequest={vi.fn()}
					permissionRequests={[
						entry("p1", "allowed"),
						entry("p2", "pending", "Write", { file_path: "/a/notes.md" }),
					]}
					onPermissionRespond={vi.fn()}
				/>,
			);

			expect(
				screen.getByRole("button", { name: /^Show permission request: Write/ }),
			).toBeInTheDocument();
			expect(screen.queryByText("Allowed")).toBeNull();
		});

		// A card the server has expired has no answer left to give from here.
		it("falls back to the statement row for an expired card", () => {
			render(
				<AttentionStrip
					turn={turn("blocked", blockers("p1"))}
					onJumpToRequest={vi.fn()}
					permissionRequests={[entry("p1", "expired")]}
					onPermissionRespond={vi.fn()}
				/>,
			);

			expect(
				screen.getByText(/Waiting for your permission\./),
			).toBeInTheDocument();
		});

		// The pressed button leaves with the answer; a keyboard user is not
		// dropped onto the page with it.
		it("keeps a keyboard answer's focus on the row", () => {
			vi.useFakeTimers();
			const props = {
				turn: turn("blocked", blockers("p1")),
				onJumpToRequest: vi.fn(),
				onPermissionRespond: vi.fn(),
			};
			const { rerender } = render(
				<AttentionStrip {...props} permissionRequests={[entry("p1")]} />,
			);
			act(() => vi.advanceTimersByTime(ARM_MS));

			const allow = screen.getByRole("button", { name: "Allow" });
			allow.focus();
			fireEvent.click(allow);
			rerender(
				<AttentionStrip
					{...props}
					permissionRequests={[entry("p1", "allowed")]}
				/>,
			);

			expect(
				screen.getByRole("button", { name: /^Show permission request/ }),
			).toHaveFocus();
		});

		it("keeps a keyboard answer's focus on the row while the jump is disabled", () => {
			vi.useFakeTimers();
			const props = {
				turn: turn("blocked", blockers("p1")),
				onJumpToRequest: vi.fn(),
				onPermissionRespond: vi.fn(),
				jumpDisabled: true,
			};
			const { rerender } = render(
				<AttentionStrip {...props} permissionRequests={[entry("p1")]} />,
			);
			act(() => vi.advanceTimersByTime(ARM_MS));

			const allow = screen.getByRole("button", { name: "Allow" });
			allow.focus();
			fireEvent.click(allow);
			rerender(
				<AttentionStrip
					{...props}
					permissionRequests={[entry("p1", "allowed")]}
				/>,
			);

			expect(
				screen.getByRole("group", { name: "Permission request" }),
			).toHaveFocus();
		});

		// The card and the tool row name an MCP call's server; one cut line
		// without it would read as a bare verb.
		it("names the call's server like the card does", () => {
			render(
				<AttentionStrip
					turn={turn("blocked", blockers("p1"))}
					onJumpToRequest={vi.fn()}
					permissionRequests={[
						entry("p1", "pending", "mcp__github__create_issue", {
							title: "Bug",
						}),
					]}
					onPermissionRespond={vi.fn()}
				/>,
			);

			expect(
				screen.getByRole("group", { name: "Permission request" }),
			).toHaveTextContent("github");
		});

		// Approving a plan approves the work after it; one cut line is not enough.
		it("sends a plan to its card instead of approving it", async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const onJump = vi.fn();
			const onRespond = vi.fn();
			render(
				<AttentionStrip
					turn={turn("blocked", blockers("p1"))}
					onJumpToRequest={onJump}
					permissionRequests={[
						entry("p1", "pending", "ExitPlanMode", { plan: "# Plan" }),
					]}
					onPermissionRespond={onRespond}
				/>,
			);

			expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
			expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
			act(() => vi.advanceTimersByTime(ARM_MS));
			expect(armed("Review")).toBe(true);
			await user.click(screen.getByRole("button", { name: "Review" }));
			expect(onJump).toHaveBeenCalledWith("p1");
			expect(onRespond).not.toHaveBeenCalled();
		});

		// Its event has not arrived, or it sits in history not paged in.
		it("falls back to the statement row when the card is not loaded", () => {
			render(
				<AttentionStrip
					turn={turn("blocked", blockers("p1"))}
					onJumpToRequest={vi.fn()}
					permissionRequests={[]}
					onPermissionRespond={vi.fn()}
				/>,
			);

			expect(
				screen.getByText(/Waiting for your permission\./),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Jump to request" }),
			).toBeInTheDocument();
		});
	});

	describe("the stories the chat watches", () => {
		const stories: WatchedStory[] = [
			{ id: "st1", title: "Ship the importer", status: "active" },
			{ id: "st2", title: "Fix the flaky test", status: "stopped" },
		];

		afterEach(() => useWorkStore.getState().reset());

		it.each([
			[
				1,
				"Watching 1 story.",
				"This chat wakes when it closes, stops, or asks.",
			],
			[
				2,
				"Watching 2 stories.",
				"This chat wakes when one closes, stops, or asks.",
			],
		])("says how many it watches (%i), and when it wakes behind Details", async (n, line, wake) => {
			const user = userEvent.setup();
			render(
				<AttentionStrip
					turn={turn("idle")}
					onJumpToRequest={vi.fn()}
					watchedStories={stories.slice(0, n)}
				/>,
			);
			expect(screen.getByText(line)).toBeInTheDocument();
			expect(screen.queryByText(wake)).toBeNull();

			await user.click(screen.getByRole("button", { name: "Details" }));
			expect(screen.getByText(wake)).toBeInTheDocument();
		});

		it("lists them behind Details, each a way to its page", async () => {
			const user = userEvent.setup();
			const onOpen = vi.fn();
			useWorkStore.getState().setWorks([
				{
					id: "st1",
					type: "story",
					title: "Ship the importer",
					status: "active",
					activity: "waiting_children",
					updated_at: "2026-01-02T14:02:00Z",
				},
			]);
			render(
				<AttentionStrip
					turn={turn("idle")}
					onJumpToRequest={vi.fn()}
					watchedStories={stories}
					onOpenWorkDetail={onOpen}
				/>,
			);

			expect(screen.queryByRole("list")).toBeNull();
			await user.click(screen.getByRole("button", { name: "Details" }));

			const list = screen.getByRole("list", { name: "Watched stories" });
			// The story's own activity, from the work list where it is paged in,
			// and from its status alone where it is not.
			expect(list).toHaveTextContent("Ship the importerWaiting on subtasks");
			expect(list).toHaveTextContent("Fix the flaky testStopped");

			await user.click(screen.getByText("Fix the flaky test"));
			expect(onOpen).toHaveBeenCalledWith("st2");
		});

		// Both are activity leaves, so the caller never passes both; a turn that
		// is blocked is the row that speaks.
		it("gives way to a background wait", () => {
			render(
				<AttentionStrip
					turn={turn("blocked", [background])}
					onJumpToRequest={vi.fn()}
					watchedStories={stories}
				/>,
			);
			expect(screen.queryByText(/Watching/)).toBeNull();
		});
	});
});
