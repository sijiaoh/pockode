import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type Activity, deriveActivity } from "../src/lib/activity";
import type { SessionTurn, TurnBlocker } from "../src/types/message";
import type { WorkStatus, WorkWait } from "../src/types/work";

/**
 * The activity derivation rule is evaluated twice — here for session rows, and
 * on the server for work rows, because a work list spans worktrees and a client
 * cannot hold the turn state of a worktree it has not opened
 * (docs/lifecycle-ui.md §1.3). So the rule is written down once, as cases, and
 * both sides are checked against that one table: a change made on one side and
 * not the other fails here.
 *
 * This lives in tests/ rather than next to activity.ts because reading the file
 * needs Node, which the browser project deliberately has no types for.
 */
interface ActivityCase {
	name: string;
	work: { status: WorkStatus; wait?: WorkWait };
	turn?: { phase: SessionTurn["phase"]; blockers?: TurnBlocker["kind"][] };
	want: Activity;
}

const CASES_PATH = resolve(
	import.meta.dirname,
	"../../server/work/testdata/activity_cases.json",
);

const cases: ActivityCase[] = JSON.parse(
	readFileSync(CASES_PATH, "utf8"),
).cases;

describe("the shared activity rule", () => {
	it("has cases to check", () => {
		expect(cases.length).toBeGreaterThan(0);
	});

	it.each(
		cases.map((c): [string, ActivityCase] => [c.name, c]),
	)("reads %s", (_name, c) => {
		const turn: SessionTurn | undefined = c.turn && {
			phase: c.turn.phase,
			open: c.turn.phase !== "idle",
			since: "2026-01-01T00:00:00Z",
			blockers: c.turn.blockers?.map((kind) => ({
				kind,
				raised_at: "2026-01-01T00:00:00Z",
			})),
		};

		expect(deriveActivity(c.work, turn)).toBe(c.want);
	});
});
