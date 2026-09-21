import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "../../lib/sessionStore";
import { useWorkStore } from "../../lib/workStore";
import { makeSessionListItem } from "../../test/sessionFixtures";
import type { SessionTurn, TurnBlocker } from "../../types/message";
import type { WorkListItem, WorkStatus, WorkWait } from "../../types/work";
import SessionItem from "./SessionItem";

const AT = "2026-01-02T14:02:00Z";

function turn(
	phase: SessionTurn["phase"],
	blockers?: TurnBlocker["kind"][],
): SessionTurn {
	return {
		phase,
		open: phase !== "idle",
		since: AT,
		blockers: blockers?.map((kind) => ({
			kind,
			request_id: kind,
			raised_at: AT,
		})),
	};
}

const WORK_ID = "w1";

function seedWork(status: WorkStatus, wait?: WorkWait) {
	const work: WorkListItem = {
		id: WORK_ID,
		type: "task",
		title: "Rewire the lifecycle",
		status,
		wait,
		// A session row derives its own activity from the turn and the work's
		// wait; the row the server computed is for the work list.
		activity: "idle",
		session_id: "s1",
		updated_at: AT,
	};
	useWorkStore.getState().setWorks([work]);
}

function renderRow(
	overrides: Partial<ReturnType<typeof makeSessionListItem>> = {},
) {
	return render(
		<SessionItem
			session={makeSessionListItem({
				id: "s1",
				title: "Chat",
				// The row names its own work; nothing scans the work list for one
				// that names this session any more.
				work_id: WORK_ID,
				...overrides,
			})}
			isActive={false}
			onSelect={vi.fn()}
			onDelete={vi.fn()}
		/>,
	);
}

beforeEach(() => {
	useWorkStore.getState().reset();
	useSessionStore.getState().reset();
});

describe("what a session row says it is waiting for", () => {
	// The one animating surface in the app, and the one place where liveness is
	// the question being asked (docs/lifecycle-ui.md §1.5).
	it("spins only while a turn is producing output", () => {
		renderRow({ turn: turn("running") });
		expect(screen.getByLabelText("Agent is running")).toBeInTheDocument();
	});

	// The two blockers a turn has, each named for what the user has to do about
	// it — and only one of them is something to do at all. A question is not here:
	// it does not block a turn, and it is drawn as a second indicator beside the
	// activity rather than as one of these (docs/lifecycle-ui.md §1.1).
	it.each<[TurnBlocker["kind"], string]>([
		["permission", "Waiting for your permission"],
		["background", "Waiting on a background task"],
	])("names a %s blocker as %s", (kind, label) => {
		renderRow({ turn: turn("blocked", [kind]) });
		expect(screen.getByLabelText(label)).toBeInTheDocument();
	});

	it("names a work waiting on its subtasks, which the turn cannot say", () => {
		seedWork("active", "child");
		renderRow({ turn: turn("idle") });
		expect(screen.getByLabelText("Waiting on subtasks")).toBeInTheDocument();
	});

	// A wait is a standing intention, a phase is a fact about this second: an
	// agent that declares a wait and keeps writing is running, and the row says so
	// until the turn settles (docs/lifecycle-ui.md §1.2).
	it("lets a live turn outrank that wait", () => {
		seedWork("active", "child");
		renderRow({ turn: turn("running") });
		expect(screen.getByLabelText("Agent is running")).toBeInTheDocument();
	});

	// A row reading "Stopped" or "Closed" would be reporting the work list's
	// business in a list that cannot act on it.
	it.each<WorkStatus>([
		"stopped",
		"closed",
		"open",
	])("says nothing about a %s work", (status) => {
		seedWork(status);
		renderRow({ turn: turn("idle"), unread: true });
		expect(screen.queryByLabelText(/Waiting|Stopped|Closed|Open/)).toBeNull();
	});

	// Which sessions belong to work is the server's answer, carried on the row.
	// A plain chat session reads nothing off the work list even when an item in
	// it still names the session — a stale `session_id` on a work the engine has
	// moved on from used to put that work's wait on an unrelated row.
	it("ignores a work that names it when the row claims none", () => {
		seedWork("active", "child");
		renderRow({ turn: turn("idle"), work_id: undefined });
		expect(screen.queryByLabelText(/Waiting/)).toBeNull();
	});

	// Precedence collapses to three tiers: anything but idle is the activity,
	// idle falls through to the unread dot, and the question glyph is a second
	// dimension beside all of it.
	it("falls back to the unread mark when nothing is waiting", () => {
		const { container } = renderRow({ turn: turn("idle"), unread: true });
		expect(screen.queryByLabelText(/Waiting|running/)).toBeNull();
		expect(container.querySelector(".bg-th-accent")).toBeInTheDocument();
	});

	// An agent that posts a question carries on running, so the two are true at
	// once and one glyph cannot say both.
	it("draws the questions beside the activity, not instead of it", () => {
		renderRow({ turn: turn("running"), unanswered_questions: 2 });
		expect(screen.getByLabelText("Agent is running")).toBeInTheDocument();
		expect(
			screen.getByLabelText("2 questions waiting for your answer"),
		).toBeInTheDocument();
	});

	// 1 is the common case and the one that most needs the width, so the glyph
	// stands alone — the label says the number either way.
	it("draws one question as a glyph alone", () => {
		renderRow({ turn: turn("idle"), unanswered_questions: 1 });
		const mark = screen.getByLabelText("1 question waiting for your answer");
		expect(mark).toBeInTheDocument();
		expect(mark.textContent).toBe("");
	});

	// The unread dot is the quietest thing a row can say; a question waiting is
	// not, and two marks for one row would be one too many.
	it("lets a waiting question stand in for the unread mark", () => {
		const { container } = renderRow({
			turn: turn("idle"),
			unread: true,
			unanswered_questions: 1,
		});
		expect(container.querySelector(".bg-th-accent")).toBeNull();
	});
});

// Deleting a session takes away the place an answer would have gone, so the
// engine stops the work behind it. A destructive action has to say the whole of
// what it does (docs/lifecycle-ui.md §8).
describe("deleting a session", () => {
	it("says which work it will stop", async () => {
		const user = userEvent.setup();
		seedWork("active");
		renderRow({ turn: turn("idle") });

		await user.click(screen.getByRole("button", { name: /delete/i }));
		expect(
			screen.getByText(/The work "Rewire the lifecycle" will stop/),
		).toBeInTheDocument();
	});

	it("says nothing about a work the engine has already let go of", async () => {
		const user = userEvent.setup();
		seedWork("closed");
		renderRow({ turn: turn("idle") });

		await user.click(screen.getByRole("button", { name: /delete/i }));
		expect(screen.queryByText(/will stop/)).toBeNull();
	});
});
