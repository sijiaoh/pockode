import { openDeferredTab } from "@pockode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

// openDeferredTab lives in packages/shared, which has no test runner of its
// own; web is where it is consumed, so it is verified from here.

describe("openDeferredTab", () => {
	const FALLBACK = "https://example.com/";

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function fakeTab() {
		return { opener: window, closed: false, location: { replace: vi.fn() } };
	}

	function deferred() {
		let resolve = (_url: string) => {};
		const promise = new Promise<string>((r) => {
			resolve = r;
		});
		return { promise, resolve };
	}

	function openWith(tab: ReturnType<typeof fakeTab>) {
		return vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
	}

	it("opens a blank tab cut from its opener before the address is known, then sends it there", async () => {
		const tab = fakeTab();
		const open = openWith(tab);
		const { promise, resolve } = deferred();

		expect(openDeferredTab(() => promise, FALLBACK)).toBe(true);
		expect(open).toHaveBeenCalledWith("", "_blank");
		expect(tab.opener).toBeNull();
		expect(tab.location.replace).not.toHaveBeenCalled();

		resolve("https://example.com/#login_ticket=t");
		await vi.waitFor(() =>
			expect(tab.location.replace).toHaveBeenCalledWith(
				"https://example.com/#login_ticket=t",
			),
		);
	});

	it("sends the tab to the fallback when the address cannot be had", async () => {
		const tab = fakeTab();
		openWith(tab);

		openDeferredTab(() => Promise.reject(new Error("Not connected")), FALLBACK);

		await vi.waitFor(() =>
			expect(tab.location.replace).toHaveBeenCalledWith(FALLBACK),
		);
	});

	it("sends the tab to the fallback when resolving throws outright", async () => {
		const tab = fakeTab();
		openWith(tab);

		expect(
			openDeferredTab(() => {
				throw new Error("No connection");
			}, FALLBACK),
		).toBe(true);

		await vi.waitFor(() =>
			expect(tab.location.replace).toHaveBeenCalledWith(FALLBACK),
		);
	});

	it("leaves a tab the user closed meanwhile alone", async () => {
		const tab = fakeTab();
		openWith(tab);
		const { promise, resolve } = deferred();

		openDeferredTab(() => promise, FALLBACK);
		tab.closed = true;
		resolve("https://example.com/later");
		// A macrotask: later than every microtask hop the helper's chain takes.
		await new Promise((r) => setTimeout(r, 0));

		expect(tab.location.replace).not.toHaveBeenCalled();
	});

	it("reports a blocked tab without resolving the address", () => {
		vi.spyOn(window, "open").mockReturnValue(null);
		const resolveUrl = vi.fn();

		expect(openDeferredTab(resolveUrl, FALLBACK)).toBe(false);
		expect(resolveUrl).not.toHaveBeenCalled();
	});
});
