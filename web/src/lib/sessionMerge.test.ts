import { describe, expect, it } from "vitest";
import { makeSessionListItem } from "../test/sessionFixtures";
import { mergeSessionRounds, type SessionViewRound } from "./sessionMerge";

function row(id: string, updatedAt: string) {
	return makeSessionListItem({ id, title: id, updated_at: updatedAt });
}

function page(
	worktree: string,
	sessions: ReturnType<typeof row>[],
	nextCursor: string | null = null,
) {
	return { worktree, sessions, nextCursor };
}

const ids = (rounds: SessionViewRound[]) =>
	mergeSessionRounds(rounds).map((r) => r.session.id);

describe("mergeSessionRounds", () => {
	it("interleaves the sources by recency", () => {
		const rounds = [
			[
				page("", [row("m1", "2026-03-03T10:00:00Z")]),
				page("feat", [row("f1", "2026-03-03T11:00:00Z")]),
			],
		];

		expect(ids(rounds)).toEqual(["f1", "m1"]);
	});

	it("says which worktree each row came from", () => {
		const merged = mergeSessionRounds([
			[page("feat", [row("f1", "2026-03-03T11:00:00Z")])],
		]);

		expect(merged[0].worktree).toBe("feat");
	});

	// The whole reason the merge is not a concatenation: feat's next page could
	// hold anything down to its own last row, so nothing below that row can be
	// shown yet — main's older rows included.
	it("stops where a source's next page could still cut in", () => {
		const rounds = [
			[
				page("", [
					row("m1", "2026-03-03T12:00:00Z"),
					row("m2", "2026-03-01T09:00:00Z"),
				]),
				page("feat", [row("f1", "2026-03-02T09:00:00Z")], "cursor"),
			],
		];

		expect(ids(rounds)).toEqual(["m1", "f1"]);
	});

	it("shows everything once every source is read to its end", () => {
		const rounds = [
			[
				page("", [
					row("m1", "2026-03-03T12:00:00Z"),
					row("m2", "2026-03-01T09:00:00Z"),
				]),
				page("feat", [row("f1", "2026-03-02T09:00:00Z")]),
			],
		];

		expect(ids(rounds)).toEqual(["m1", "f1", "m2"]);
	});

	// A later round only ever adds rows *below* the line the previous one
	// stopped at, which is what lets the reader scroll without rows appearing
	// above them (docs/list-paging-ui.md §2.4).
	it("extends the list downwards as later rounds arrive", () => {
		const first: SessionViewRound = [
			page("", [row("m1", "2026-03-03T12:00:00Z")], "c1"),
			page("feat", [row("f1", "2026-03-02T09:00:00Z")], "c2"),
		];
		const second: SessionViewRound = [
			page("", [row("m2", "2026-03-01T09:00:00Z")]),
			page("feat", [row("f2", "2026-02-28T09:00:00Z")]),
		];

		expect(ids([first])).toEqual(["m1"]);
		expect(ids([first, second])).toEqual(["m1", "f1", "m2", "f2"]);
	});

	// Ties are broken the way the server breaks them, or the two sides would
	// disagree about what "the row after this one" means.
	it("breaks a tie on updated_at by id, descending", () => {
		const rounds = [
			[
				page("", [row("a", "2026-03-03T10:00:00Z")]),
				page("feat", [row("b", "2026-03-03T10:00:00Z")]),
			],
		];

		expect(ids(rounds)).toEqual(["b", "a"]);
	});

	// A session touched between two requests moves in its source's order, and a
	// refresh re-reads rounds that already landed. Either way the same row can
	// arrive twice, and a list that draws it twice is a list with two of the
	// same conversation in it (docs/list-paging-ui.md §3.3).
	it("keeps one row per session, the newest copy", () => {
		const rounds = [
			[page("", [row("m1", "2026-03-01T09:00:00Z")])],
			[page("", [row("m1", "2026-03-04T09:00:00Z")])],
		];

		const merged = mergeSessionRounds(rounds);
		expect(merged).toHaveLength(1);
		expect(merged[0].session.updated_at).toBe("2026-03-04T09:00:00Z");
	});

	it("shows nothing while a source with more to come has given nothing", () => {
		const rounds = [
			[
				page("", [row("m1", "2026-03-03T10:00:00Z")]),
				page("feat", [], "cursor"),
			],
		];

		expect(ids(rounds)).toEqual([]);
	});
});
