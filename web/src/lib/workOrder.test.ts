import { describe, expect, it } from "vitest";
import type { WorkListItem } from "../types/work";
import { byUpdatedDesc } from "./workOrder";

const work = (id: string, updated_at: string): WorkListItem => ({
	id,
	type: "story",
	title: id,
	status: "open",
	activity: "open",
	updated_at,
});

describe("byUpdatedDesc", () => {
	// The server writes `updated_at` from local time and serialises each moment
	// with its own UTC offset, so one list holds both spellings. Compared as
	// text these sort the wrong way round, and only ever across a timezone or a
	// DST change — which is why it is worth a test of its own.
	it("compares moments, not the strings they are spelled with", () => {
		const rows = [
			work("stale", "2026-03-04T09:00:00+09:00"),
			work("fresh", "2026-03-04T02:00:00Z"),
		];

		expect([...rows].sort(byUpdatedDesc).map((w) => w.id)).toEqual([
			"fresh",
			"stale",
		]);
	});

	// Ids are uuid v7, so the higher id is the newer work — and this is the
	// server's own tie-break, which is what lets the two segments claim to share
	// one order rather than two that usually agree.
	it("breaks a tie on the newer id", () => {
		const at = "2026-03-04T00:00:00Z";
		const rows = [work("019f0000", at), work("019f0001", at)];

		expect([...rows].sort(byUpdatedDesc).map((w) => w.id)).toEqual([
			"019f0001",
			"019f0000",
		]);
	});
});
