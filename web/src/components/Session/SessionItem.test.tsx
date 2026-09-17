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

	// Three separate "needs you" leaves, because what the user has to *do*
	// differs in each. Collapsing them back into one is the field this redesign
	// removes (docs/lifecycle-ui.md §1.1).
	it.each<[TurnBlocker["kind"], string]>([
		["question", "Waiting for your answer"],
		["permission", "Waiting for your permission"],
		["background", "Waiting on a background task"],
	])("names a %s blocker as %s", (kind, label) => {
		renderRow({ turn: turn("blocked", [kind]) });
		expect(screen.getByLabelText(label)).toBeInTheDocument();
	});

	it("names a work waiting on the user, which the turn cannot say", () => {
		seedWork("active", "user");
		renderRow({ turn: turn("idle") });
		expect(
			screen.getByLabelText("Waiting for your message"),
		).toBeInTheDocument();
	});

	// A wait is a standing intention, a phase is a fact about this second: an
	// agent that asks for input and keeps writing is running, and the row says so
	// until the turn settles (docs/lifecycle-ui.md §1.2).
	it("lets a live turn outrank that wait", () => {
		seedWork("active", "user");
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
		seedWork("active", "user");
		renderRow({ turn: turn("idle"), work_id: undefined });
		expect(screen.queryByLabelText(/Waiting/)).toBeNull();
	});

	// Precedence collapses to two lines: anything but idle is the activity, and
	// idle falls through to the unread dot.
	it("falls back to the unread mark when nothing is waiting", () => {
		const { container } = renderRow({ turn: turn("idle"), unread: true });
		expect(screen.queryByLabelText(/Waiting|running/)).toBeNull();
		expect(container.querySelector(".bg-th-accent")).toBeInTheDocument();
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
