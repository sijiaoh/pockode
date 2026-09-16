import { describe, expect, it } from "vitest";
import type { SessionTurn, TurnBlocker } from "../types/message";
import type { WorkStatus } from "../types/work";
import {
	ACTIVITY_VIEW,
	type Activity,
	deriveActivity,
	needsUser,
	sessionActivity,
} from "./activity";

function turn(
	phase: SessionTurn["phase"],
	blockers?: TurnBlocker["kind"][],
): SessionTurn {
	return {
		phase,
		open: phase !== "idle",
		since: "2026-01-01T00:00:00Z",
		blockers: blockers?.map((kind) => ({
			kind,
			raised_at: "2026-01-01T00:00:00Z",
		})),
	};
}

const work = (status: WorkStatus) => ({ status });

describe("deriveActivity", () => {
	it.each<[string, WorkStatus | undefined, SessionTurn | undefined, Activity]>([
		["a work nobody has started", "open", undefined, "open"],
		["a finished work", "closed", turn("running"), "closed"],
		["a stopped work", "stopped", turn("running"), "stopped"],
		["a session with no work at all", undefined, turn("running"), "running"],
		["an untouched session", undefined, turn("idle"), "idle"],
		["a live turn", "in_progress", turn("running"), "running"],
		["a settled turn", "in_progress", turn("idle"), "idle"],
	])("reads %s as %s", (_name, status, sessionTurn, expected) => {
		expect(deriveActivity(status ? work(status) : undefined, sessionTurn)).toBe(
			expected,
		);
	});

	it.each<[TurnBlocker["kind"][], Activity]>([
		[["permission"], "needs_permission"],
		[["question"], "needs_answer"],
		[["background"], "background"],
		// Permission outranks question: it is the one that cannot degrade into a
		// message, so its deadline is the one that costs something.
		[["question", "permission"], "needs_permission"],
		// The agent parked on a task and then asked; the person is the one waiting.
		[["background", "question"], "needs_answer"],
	])("names %s as %s", (blockers, expected) => {
		expect(deriveActivity(work("in_progress"), turn("blocked", blockers))).toBe(
			expected,
		);
	});

	// The phase is a fact about this second; the wait is a standing intention. An
	// agent that asks for input and then keeps writing is running, and the row
	// should say so until the turn settles.
	it("lets a running turn outrank a work that is waiting on the user", () => {
		expect(deriveActivity(work("needs_input"), turn("running"))).toBe(
			"running",
		);
		expect(deriveActivity(work("needs_input"), turn("idle"))).toBe(
			"needs_message",
		);
		expect(deriveActivity(work("waiting"), turn("idle"))).toBe(
			"waiting_children",
		);
	});
});

describe("sessionActivity", () => {
	// A row reading "Stopped" or "Closed" would be reporting the work list's
	// business in a list that cannot act on it.
	it.each<WorkStatus>([
		"open",
		"stopped",
		"closed",
	])("never shows a %s work's status on a session row", (status) => {
		expect(sessionActivity(turn("idle"), work(status))).toBe("idle");
	});

	// The other half of the same call: the wait *is* a fact about this
	// conversation, and it is what tells the user a session they are not looking
	// at is waiting on them.
	it("shows an active work's wait", () => {
		expect(sessionActivity(turn("idle"), work("needs_input"))).toBe(
			"needs_message",
		);
		expect(sessionActivity(turn("idle"), work("waiting"))).toBe(
			"waiting_children",
		);
	});

	it("draws a session with no work from its turn alone", () => {
		expect(sessionActivity(turn("blocked", ["question"]), undefined)).toBe(
			"needs_answer",
		);
	});
});

describe("needsUser", () => {
	// A dot that means "something is happening" is a dot the user learns to
	// ignore, which is what made the old needs-input dot worthless.
	it("is exactly the three leaves the user can clear", () => {
		const flagged = (Object.keys(ACTIVITY_VIEW) as Activity[]).filter(
			needsUser,
		);
		expect(flagged.sort()).toEqual([
			"needs_answer",
			"needs_message",
			"needs_permission",
		]);
	});

	it("keeps the warning hue and the predicate in step", () => {
		for (const activity of Object.keys(ACTIVITY_VIEW) as Activity[]) {
			expect(ACTIVITY_VIEW[activity].tone === "warning").toBe(
				needsUser(activity),
			);
		}
	});
});
