import { describe, expect, it } from "vitest";
import type { SessionTurn, TurnBlocker } from "../types/message";
import type { WorkStatus, WorkWait } from "../types/work";
import {
	ACTIVITY_VIEW,
	type Activity,
	deriveActivity,
	needsAttention,
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

const work = (status: WorkStatus, wait?: WorkWait) => ({ status, wait });

describe("deriveActivity", () => {
	// The rule itself is checked against the table shared with the server, in
	// tests/activityRule.test.ts. What is left here is the case that table cannot
	// state, because it is about a surface the server does not draw: a session
	// that belongs to no work at all.
	it("draws a session with no work from its turn alone", () => {
		expect(deriveActivity(undefined, turn("running"))).toBe("running");
		expect(deriveActivity(undefined, turn("idle"))).toBe("idle");
		expect(deriveActivity(undefined, turn("blocked", ["permission"]))).toBe(
			"needs_permission",
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
		expect(sessionActivity(turn("idle"), work("active", "child"))).toBe(
			"waiting_children",
		);
	});

	it("draws a session with no work from its turn alone", () => {
		expect(sessionActivity(turn("blocked", ["permission"]), undefined)).toBe(
			"needs_permission",
		);
	});
});

describe("needsAttention", () => {
	// A dot that means "something is happening" is a dot the user learns to
	// ignore, which is what made the old needs-input dot worthless.
	it("is exactly the one leaf the user can clear", () => {
		const flagged = (Object.keys(ACTIVITY_VIEW) as Activity[]).filter((a) =>
			needsAttention(a),
		);
		expect(flagged).toEqual(["needs_permission"]);
	});

	it("keeps the warning hue and the activity half of the predicate in step", () => {
		for (const activity of Object.keys(ACTIVITY_VIEW) as Activity[]) {
			expect(ACTIVITY_VIEW[activity].tone === "warning").toBe(
				needsAttention(activity),
			);
		}
	});

	// The second dimension is independent of the first, which is the whole
	// reason it exists: an agent that posts a question carries on running.
	it("is true for an unanswered question whatever the activity says", () => {
		for (const activity of Object.keys(ACTIVITY_VIEW) as Activity[]) {
			expect(needsAttention(activity, 1)).toBe(true);
		}
	});

	it("reads no questions as no questions", () => {
		expect(needsAttention("running", 0)).toBe(false);
		expect(needsAttention("running")).toBe(false);
	});
});
