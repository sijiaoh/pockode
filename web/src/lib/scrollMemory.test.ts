import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { entryKeyOf, scrollMemoryFor } from "./scrollMemory";

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

	it("takes a push to the page just underneath as the header's Back", () => {
		const { history, leaveAt, saved } = setup();
		leaveAt(500);
		history.push("/detail");
		history.push("/list");
		expect(saved()).toBe(500);
	});

	it("still recognises that Back after the page on top was replaced", () => {
		const { history, leaveAt, saved } = setup();
		leaveAt(500);
		history.push("/detail");
		history.replace("/detail?side=staged");
		history.push("/list");
		expect(saved()).toBe(500);
	});

	it("keeps a replaced page's position for the entry that replaced it", () => {
		const { history, leaveAt, saved } = setup();
		leaveAt(500);
		history.replace("/list?side=staged");
		expect(saved()).toBe(500);
	});

	it("starts a fresh visit at the top, even of a page left scrolled", () => {
		const { history, leaveAt, saved } = setup("/history");
		history.push("/commit");
		leaveAt(500);
		// The header's Back from the commit, then the same commit opened again:
		// a new visit, not a return.
		history.push("/history");
		history.push("/commit");
		expect(saved()).toBeUndefined();
	});

	it("does not take a push to a page further down the trail as Back", () => {
		const { history, leaveAt, saved } = setup();
		leaveAt(500);
		history.push("/detail");
		history.push("/file");
		history.push("/list");
		expect(saved()).toBeUndefined();
	});
});
