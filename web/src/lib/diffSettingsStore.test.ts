import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	useDiffSettingsStore,
	useGitDiffSplit,
	useGitDiffWrap,
} from "./diffSettingsStore";

let expanded = false;
vi.mock("@pockode/shared", async (importOriginal) => ({
	...(await importOriginal<typeof import("@pockode/shared")>()),
	useIsExpanded: () => expanded,
}));

describe("useGitDiffWrap", () => {
	beforeEach(() => {
		localStorage.clear();
		useDiffSettingsStore.setState({ gitDiffWrap: null, wrapLines: false });
	});

	it("wraps below expanded and not at expanded until the reader chooses", () => {
		expanded = false;
		const { result, rerender } = renderHook(() => useGitDiffWrap());
		expect(result.current.wrap).toBe(true);

		expanded = true;
		rerender();
		expect(result.current.wrap).toBe(false);
	});

	it("keeps the reader's choice at every width, and remembers it", () => {
		expanded = false;
		const { result, rerender } = renderHook(() => useGitDiffWrap());
		act(() => result.current.toggleWrap());
		expect(result.current.wrap).toBe(false);

		expanded = true;
		rerender();
		expect(result.current.wrap).toBe(false);
		expect(localStorage.getItem("pockode:gitReviewWrap")).toBe("false");
	});

	it("is not the chat's wrap setting", () => {
		expanded = true;
		const { result } = renderHook(() => useGitDiffWrap());
		act(() => result.current.toggleWrap());
		expect(result.current.wrap).toBe(true);
		expect(useDiffSettingsStore.getState().wrapLines).toBe(false);
	});
});

describe("useGitDiffSplit", () => {
	beforeEach(() => {
		localStorage.clear();
		useDiffSettingsStore.setState({ gitDiffSplit: false });
	});

	it("is inline until the reader chooses side by side, and remembers it", () => {
		expanded = true;
		const { result } = renderHook(() => useGitDiffSplit());
		expect(result.current.split).toBe(false);

		act(() => result.current.toggleSplit());
		expect(result.current.split).toBe(true);
		expect(localStorage.getItem("pockode:gitReviewSplit")).toBe("true");
	});

	// No width for two columns below expanded; the choice waits for the tier.
	it("is offered and applied only at expanded", () => {
		expanded = true;
		const { result, rerender } = renderHook(() => useGitDiffSplit());
		act(() => result.current.toggleSplit());

		expanded = false;
		rerender();
		expect(result.current).toMatchObject({ available: false, split: false });

		expanded = true;
		rerender();
		expect(result.current).toMatchObject({ available: true, split: true });
	});
});
