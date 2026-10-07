import { beforeEach, describe, expect, it, vi } from "vitest";
// Every case loads the store fresh, since it reads storage as it loads.
// Importing it here as well pays the transform, which survives
// resetModules, in the untimed import phase instead of in the first case's
// timeout.
import "./portPreviewStore";

const STORAGE_KEY = "pockode:preview-ports";

async function loadStore() {
	return import("./portPreviewStore");
}

describe("portPreviewStore", () => {
	beforeEach(() => {
		vi.resetModules();
		localStorage.clear();
	});

	it("restores stored ports", async () => {
		localStorage.setItem(STORAGE_KEY, "[6006,5173]");
		const { usePortPreviewStore } = await loadStore();

		expect(usePortPreviewStore.getState().recentPorts).toEqual([6006, 5173]);
	});

	it.each([
		["unparseable", "{oops"],
		["not an array", '{"port":5173}'],
	])("starts empty when storage is %s", async (_, stored) => {
		localStorage.setItem(STORAGE_KEY, stored);
		const { usePortPreviewStore } = await loadStore();

		expect(usePortPreviewStore.getState().recentPorts).toEqual([]);
	});

	it("drops stored entries that are not ports, and repeats", async () => {
		localStorage.setItem(
			STORAGE_KEY,
			'[5173,"6006",0,70000,1.5,null,3000,5173]',
		);
		const { usePortPreviewStore } = await loadStore();

		expect(usePortPreviewStore.getState().recentPorts).toEqual([5173, 3000]);
	});

	it("keeps the five most recently opened, newest first and without duplicates", async () => {
		const { usePortPreviewStore, portPreviewActions } = await loadStore();

		for (const port of [3000, 5173, 6006, 8080, 4000, 5173, 9000]) {
			portPreviewActions.recordPort(port);
		}

		const expected = [9000, 5173, 4000, 8080, 6006];
		expect(usePortPreviewStore.getState().recentPorts).toEqual(expected);
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "")).toEqual(
			expected,
		);
	});

	it("persists a removal", async () => {
		const { usePortPreviewStore, portPreviewActions } = await loadStore();
		portPreviewActions.recordPort(5173);
		portPreviewActions.recordPort(6006);

		portPreviewActions.removePort(5173);

		expect(usePortPreviewStore.getState().recentPorts).toEqual([6006]);
		expect(localStorage.getItem(STORAGE_KEY)).toBe("[6006]");
	});
});
