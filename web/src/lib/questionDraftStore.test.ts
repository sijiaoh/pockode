import { beforeEach, describe, expect, it, vi } from "vitest";
// Every case loads the store fresh, since it reads storage as it loads.
// Importing it here as well pays the transform, which survives
// resetModules, in the untimed import phase instead of in the first case's
// or a hook's timeout.
import "./questionDraftStore";
import type { QuestionDraft } from "./questionDraftStore";

const answer: QuestionDraft = {
	labels: ["Postgres"],
	text: "",
	otherPicked: false,
	declined: false,
	note: "",
};

/** The store as a freshly loaded page sees it: rehydrated from what is stored. */
async function reload() {
	vi.resetModules();
	return await import("./questionDraftStore");
}

function stored(): Record<string, Record<string, QuestionDraft>> {
	const raw = localStorage.getItem("question_drafts");
	return raw ? JSON.parse(raw).state.drafts : {};
}

beforeEach(() => {
	localStorage.clear();
	vi.resetModules();
});

describe("questionDraftStore", () => {
	it("keeps a draft across a reload when the arriving list still carries its question", async () => {
		const first = await reload();
		first.questionDraftActions.set("s1", "r1", answer);

		const { useQuestionDraftStore, questionDraftActions } = await reload();
		// Nothing is on screen until the list has vouched for it.
		expect(useQuestionDraftStore.getState().drafts.s1).toBeUndefined();

		questionDraftActions.restore("s1", ["r1"]);
		expect(useQuestionDraftStore.getState().drafts.s1?.r1).toEqual(answer);
	});

	it("drops a stored draft whose question the arriving list no longer carries", async () => {
		const first = await reload();
		first.questionDraftActions.set("s1", "r1", answer);

		const { useQuestionDraftStore, questionDraftActions } = await reload();
		questionDraftActions.restore("s1", ["r2"]);

		expect(useQuestionDraftStore.getState().drafts.s1?.r1).toBeUndefined();
		// And it does not pile up in storage for the next reload to weigh.
		expect(stored().s1?.r1).toBeUndefined();
	});

	// The old promise: a question that leaves the list while holding a draft keeps
	// its block on screen, so the list arriving without it must not delete what
	// the user can still see.
	it("never drops a draft typed since the page loaded", async () => {
		const { useQuestionDraftStore, questionDraftActions } = await reload();
		questionDraftActions.set("s1", "r1", answer);

		questionDraftActions.restore("s1", []);

		expect(useQuestionDraftStore.getState().drafts.s1?.r1).toEqual(answer);
	});

	// Storage holds every session at once and is rewritten whole, so a session
	// this page never opened must survive a change made in the one it did.
	it("leaves the stored drafts of a session it has not checked alone", async () => {
		const first = await reload();
		first.questionDraftActions.set("s1", "r1", answer);
		first.questionDraftActions.set("s2", "r9", answer);

		const { questionDraftActions } = await reload();
		questionDraftActions.restore("s1", ["r1"]);
		questionDraftActions.clear("s1", ["r1"]);

		expect(stored().s2?.r9).toEqual(answer);
	});

	it("clears a submitted draft out of storage, leaving nothing behind", async () => {
		const { questionDraftActions } = await reload();
		questionDraftActions.set("s1", "r1", answer);
		questionDraftActions.clear("s1", ["r1"]);

		// Not an empty entry under `s1`: every session answered in would leave one.
		expect(stored()).toEqual({});
	});
});
