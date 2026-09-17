import { describe, expect, it } from "vitest";
import type { SessionTurn, TurnBlocker } from "../types/message";
import type { WorkStatus, WorkWait } from "../types/work";
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

const work = (status: WorkStatus, wait?: WorkWait) => ({ status, wait });

describe("deriveActivity", () => {
	// The rule itself is checked against the table shared with the server, in
	// tests/activityRule.test.ts. What is left here is the case that table cannot
	// state, because it is about a surface the server does not draw: a session
	// that belongs to no work at all.
	it("draws a session with no work from its turn alone", () => {
		expect(deriveActivity(undefined, turn("running"))).toBe("running");
		expect(deriveActivity(undefined, turn("idle"))).toBe("idle");
		expect(deriveActivity(undefined, turn("blocked", ["question"]))).toBe(
			"needs_answer",
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
		expect(sessionActivity(turn("idle"), work("active", "user"))).toBe(
			"needs_message",
		);
		expect(sessionActivity(turn("idle"), work("active", "child"))).toBe(
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
