import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { memoryStorage } from "../test/memoryStorage";
import { entryKeyOf, historyTrailFor } from "./historyTrail";

const hrefs = (trail: ReturnType<typeof historyTrailFor>) =>
	Array.from({ length: (trail.index ?? -1) + 1 }, (_, i) => trail.at(i)?.href);

describe("historyTrail", () => {
	it("follows pushes, replaces and moves back", () => {
		const history = createMemoryHistory({ initialEntries: ["/a"] });
		const trail = historyTrailFor(history);
		history.push("/b");
		history.push("/c");
		history.replace("/c2");
		expect(hrefs(trail)).toEqual(["/a", "/b", "/c2"]);

		history.back();
		expect(trail.index).toBe(1);
		// A push from there drops what was ahead of it.
		history.push("/d");
		expect(hrefs(trail)).toEqual(["/a", "/b", "/d"]);
		expect(trail.at(3)).toBeUndefined();
	});

	// A reload of the same entry keeps knowing what is behind it.
	it("is read back from storage for the entry it was left on", () => {
		const storage = memoryStorage();
		const first = createMemoryHistory({ initialEntries: ["/a"] });
		historyTrailFor(first, storage);
		first.push("/b");

		// The same tab's history, read by a new document: the entry on screen
		// still carries the key it was written with.
		const reloaded = createMemoryHistory({ initialEntries: ["/x", "/b"] });
		Object.assign(reloaded.location.state, {
			key: first.location.state.key,
			__TSR_key: entryKeyOf(first.location),
		});
		const trail = historyTrailFor(reloaded, storage);
		expect(hrefs(trail)).toEqual(["/a", "/b"]);
		// What it read back is the gone document's; what it writes is its own.
		expect(trail.at(0)?.doc).not.toBe(trail.document);
		expect(trail.at(1)?.doc).toBe(trail.document);
	});

	// A URL typed into the address bar starts a document the router numbers
	// from 0 again: what is stored is another document's, and not believed.
	it("knows only the entry on screen when storage does not describe it", () => {
		const storage = memoryStorage();
		const first = createMemoryHistory({ initialEntries: ["/a"] });
		historyTrailFor(first, storage);
		first.push("/b");

		const typed = createMemoryHistory({ initialEntries: ["/x", "/typed"] });
		const trail = historyTrailFor(typed, storage);
		expect(trail.index).toBe(1);
		expect(trail.at(0)).toBeUndefined();
		expect(trail.at(1)?.href).toBe("/typed");
	});

	it("forgets what it knew when the history moves somewhere unknown", () => {
		const history = createMemoryHistory({ initialEntries: ["/a", "/b"] });
		const trail = historyTrailFor(history);
		history.back();
		expect(trail.index).toBe(0);
		expect(trail.at(0)?.href).toBe("/a");
		expect(trail.at(1)).toBeUndefined();
	});

	// The entry gone back to was another document's, and loads the app
	// afresh: the rewrite owed to it is made as the new trail starts.
	it("rewrites the entry arrived at in a new document", () => {
		const storage = memoryStorage();
		const first = createMemoryHistory({ initialEntries: ["/a"] });
		const trail = historyTrailFor(first, storage);
		trail.rewriteOnArrival(entryKeyOf(first.location), "/parent");

		const arrived = createMemoryHistory({ initialEntries: ["/a"] });
		Object.assign(arrived.location.state, {
			__TSR_key: entryKeyOf(first.location),
		});
		const next = historyTrailFor(arrived, storage);
		expect(arrived.location.href).toBe("/parent");
		expect(next.at(0)?.href).toBe("/parent");
	});

	it("rewrites nothing arrived at somewhere else, or once cancelled", () => {
		const storage = memoryStorage();
		const first = createMemoryHistory({ initialEntries: ["/a"] });
		const trail = historyTrailFor(first, storage);
		trail.rewriteOnArrival("another entry", "/parent");

		const elsewhere = createMemoryHistory({ initialEntries: ["/b"] });
		historyTrailFor(elsewhere, storage);
		expect(elsewhere.location.href).toBe("/b");

		trail.rewriteOnArrival(entryKeyOf(first.location), "/parent");
		trail.cancelRewrite();
		const again = createMemoryHistory({ initialEntries: ["/a"] });
		Object.assign(again.location.state, {
			__TSR_key: entryKeyOf(first.location),
		});
		historyTrailFor(again, storage);
		expect(again.location.href).toBe("/a");
	});
});
