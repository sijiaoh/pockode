import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDeviceTimeZone } from "./useDeviceTimeZone";

function reportZone(timeZone: string) {
	const real = Intl.DateTimeFormat.prototype.resolvedOptions;
	vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(
		function (this: Intl.DateTimeFormat) {
			return { ...real.call(this), timeZone };
		},
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("useDeviceTimeZone", () => {
	it.each([
		["focus", () => window.dispatchEvent(new Event("focus"))],
		[
			"visibilitychange",
			() => document.dispatchEvent(new Event("visibilitychange")),
		],
	])("reads the zone again on %s", (_, fire) => {
		reportZone("Asia/Tokyo");
		const { result } = renderHook(() => useDeviceTimeZone());
		expect(result.current).toBe("Asia/Tokyo");

		// A phone that landed in London while the app was in the background.
		vi.restoreAllMocks();
		reportZone("Europe/London");
		act(fire);
		expect(result.current).toBe("Europe/London");
	});
});
