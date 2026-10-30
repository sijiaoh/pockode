import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { entryKeyOf } from "./historyTrail";
import { FRESH_VISIT_STATE, scrollMemoryFor } from "./scrollMemory";

function setup(path = "/list") {
	const history = createMemoryHistory({ initialEntries: [path] });
	const memory = scrollMemoryFor(history);
	const here = () => entryKeyOf(history.location);
	const leaveAt = (top: number) => memory.set(here(), "page", top);
	const saved = () => memory.get(here(), "page");
	return { history, leaveAt, saved };
}

describe("scrollMemory", () => {
	it("gives the browser's Back the position its entry was left at", () => {
		const { history, leaveAt, saved } = setup();
		leaveAt(500);
		history.push("/detail");
		expect(saved()).toBeUndefined();

		history.back();
		expect(saved()).toBe(500);
	});

	it("starts a push of the page just underneath at the top", () => {
		const { history, leaveAt, saved } = setup();
		leaveAt(500);
		history.push("/detail");
		// An entrance to the list, not a return: a return goes back to its entry.
		history.push("/list");
		expect(saved()).toBeUndefined();
	});

	it("keeps a replaced page's position for the entry that replaced it", () => {
		const { history, leaveAt, saved } = setup();
		leaveAt(500);
		history.replace("/list?side=staged");
		expect(saved()).toBe(500);
	});

	it("starts another page put in place of the one on screen at the top", () => {
		const { history, leaveAt, saved } = setup("/commit-diff");
		leaveAt(500);
		// A parent standing in for the child its ← was pressed on.
		history.replace("/commit", FRESH_VISIT_STATE);
		expect(saved()).toBeUndefined();
	});
});
