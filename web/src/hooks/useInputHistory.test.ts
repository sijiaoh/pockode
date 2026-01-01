import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInputHistory } from "./useInputHistory";

const STORAGE_KEY = "input_history";

describe("useInputHistory", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		localStorage.clear();
	});

	describe("saveToHistory", () => {
		it("saves message to localStorage", () => {
			const { result } = renderHook(() => useInputHistory());

			act(() => {
				result.current.saveToHistory("hello");
			});

			const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
			expect(stored).toEqual(["hello"]);
		});

		it("adds new messages to the front", () => {
			const { result } = renderHook(() => useInputHistory());

			act(() => {
				result.current.saveToHistory("first");
				result.current.saveToHistory("second");
			});

			const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
			expect(stored).toEqual(["second", "first"]);
		});

		it("does not save duplicate consecutive messages", () => {
			const { result } = renderHook(() => useInputHistory());

			act(() => {
				result.current.saveToHistory("same");
				result.current.saveToHistory("same");
			});

			const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
			expect(stored).toEqual(["same"]);
		});

		it("trims whitespace before saving", () => {
			const { result } = renderHook(() => useInputHistory());

			act(() => {
				result.current.saveToHistory("  hello  ");
			});

			const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
			expect(stored).toEqual(["hello"]);
		});

		it("does not save empty messages", () => {
			const { result } = renderHook(() => useInputHistory());

			act(() => {
				result.current.saveToHistory("");
				result.current.saveToHistory("   ");
			});

			const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
			expect(stored).toEqual([]);
		});

		it("limits history to 100 entries", () => {
			const { result } = renderHook(() => useInputHistory());

			act(() => {
				for (let i = 0; i < 110; i++) {
					result.current.saveToHistory(`message ${i}`);
				}
			});

			const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
			expect(stored.length).toBe(100);
			expect(stored[0]).toBe("message 109");
		});
	});

	describe("navigation", () => {
		it("returns null when history is empty", () => {
			const { result } = renderHook(() => useInputHistory());

			let previous: string | null = null;
			act(() => {
				previous = result.current.getPrevious("");
			});

			expect(previous).toBeNull();
		});

		it("navigates through history with getPrevious", () => {
			localStorage.setItem(
				STORAGE_KEY,
				JSON.stringify(["third", "second", "first"]),
			);
			const { result } = renderHook(() => useInputHistory());

			let value: string | null = null;

			act(() => {
				value = result.current.getPrevious("");
			});
			expect(value).toBe("third");

			act(() => {
				value = result.current.getPrevious("");
			});
			expect(value).toBe("second");

			act(() => {
				value = result.current.getPrevious("");
			});
			expect(value).toBe("first");

			act(() => {
				value = result.current.getPrevious("");
			});
			expect(value).toBeNull();
		});

		it("navigates back with getNext", () => {
			localStorage.setItem(
				STORAGE_KEY,
				JSON.stringify(["third", "second", "first"]),
			);
			const { result } = renderHook(() => useInputHistory());

			act(() => {
				result.current.getPrevious("");
				result.current.getPrevious("");
			});

			let value: string | null = null;
			act(() => {
				value = result.current.getNext();
			});
			expect(value).toBe("third");
		});

		it("preserves draft when navigating", () => {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(["history"]));
			const { result } = renderHook(() => useInputHistory());

			let value: string | null = null;

			act(() => {
				result.current.getPrevious("my draft");
			});

			act(() => {
				value = result.current.getNext();
			});

			expect(value).toBe("my draft");
		});

		it("returns null for getNext when already at draft", () => {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(["history"]));
			const { result } = renderHook(() => useInputHistory());

			let value: string | null = null;
			act(() => {
				value = result.current.getNext();
			});

			expect(value).toBeNull();
		});

		it("resetNavigation resets position to draft", () => {
			localStorage.setItem(
				STORAGE_KEY,
				JSON.stringify(["third", "second", "first"]),
			);
			const { result } = renderHook(() => useInputHistory());

			act(() => {
				result.current.getPrevious("");
				result.current.getPrevious("");
				result.current.resetNavigation();
			});

			let value: string | null = null;
			act(() => {
				value = result.current.getPrevious("");
			});

			expect(value).toBe("third");
		});
	});

	describe("error handling", () => {
		it("handles corrupted localStorage data", () => {
			localStorage.setItem(STORAGE_KEY, "not valid json");
			const { result } = renderHook(() => useInputHistory());

			let value: string | null = null;
			act(() => {
				value = result.current.getPrevious("");
			});

			expect(value).toBeNull();
		});

		it("handles non-array localStorage data", () => {
			localStorage.setItem(STORAGE_KEY, JSON.stringify({ foo: "bar" }));
			const { result } = renderHook(() => useInputHistory());

			let value: string | null = null;
			act(() => {
				value = result.current.getPrevious("");
			});

			expect(value).toBeNull();
		});

		it("handles localStorage write failure gracefully", () => {
			const mockSetItem = vi.spyOn(Storage.prototype, "setItem");
			mockSetItem.mockImplementation(() => {
				throw new Error("QuotaExceeded");
			});

			const { result } = renderHook(() => useInputHistory());

			expect(() => {
				act(() => {
					result.current.saveToHistory("test");
				});
			}).not.toThrow();

			mockSetItem.mockRestore();
		});
	});
});
