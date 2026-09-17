import { beforeEach, describe, expect, it } from "vitest";
import type { WorkListItem } from "../types/work";
import { useWorkStore } from "./workStore";

const row = (overrides: Partial<WorkListItem> = {}): WorkListItem => ({
	id: "w1",
	type: "task",
	title: "Rewire the lifecycle",
	status: "active",
	activity: "running",
	updated_at: "2026-03-04T00:00:00Z",
	...overrides,
});

describe("the work store's wire boundary", () => {
	beforeEach(() => {
		useWorkStore.getState().reset();
	});

	// A client talking to a newer server must not blank a row over a leaf it has
	// never heard of, and `idle` is the leaf that claims the least.
	it("folds an activity this build does not know to idle", () => {
		const unknown = { activity: "reticulating" } as unknown as WorkListItem;

		useWorkStore.getState().setWorks([row(unknown)]);

		expect(useWorkStore.getState().works[0].activity).toBe("idle");
	});

	// `in` would walk the prototype chain and let this through, and the view map
	// would then hand a row a function where its glyph should be.
	it("folds an inherited property name to idle as well", () => {
		useWorkStore
			.getState()
			.setWorks([row({ activity: "toString" as WorkListItem["activity"] })]);

		expect(useWorkStore.getState().works[0].activity).toBe("idle");
	});

	// The same boundary on the other writer: a row arriving as a change
	// notification goes through the store, not through the caller's memory of it.
	it("folds it on an update as well as on a full list", () => {
		useWorkStore.getState().setWorks([row()]);

		useWorkStore
			.getState()
			.updateWorks(() => [
				row({ activity: "who knows" as WorkListItem["activity"] }),
			]);

		expect(useWorkStore.getState().works[0].activity).toBe("idle");
	});

	// A row it leaves alone is returned unchanged, so the rows React is diffing
	// keep their identity across a notification that did not touch them.
	it("returns a recognised row as it arrived", () => {
		const untouched = row({ id: "w2", activity: "needs_answer" });

		useWorkStore.getState().setWorks([untouched]);

		expect(useWorkStore.getState().works[0]).toBe(untouched);
	});
});
