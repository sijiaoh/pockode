import { describe, expect, it } from "vitest";
import { formatBytes } from "./bytes";

describe("formatBytes", () => {
	it("leaves byte counts whole", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(852)).toBe("852 B");
	});

	it("steps up through binary units", () => {
		expect(formatBytes(1024)).toBe("1 KB");
		expect(formatBytes(254_083)).toBe("248 KB");
		expect(formatBytes(13_002_342)).toBe("12.4 MB");
		expect(formatBytes(5 * 1024 ** 3)).toBe("5 GB");
	});

	it("keeps a decimal only where it says something", () => {
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(2 << 20)).toBe("2 MB");
		// Above 100 the tenths place is noise, not precision.
		expect(formatBytes(254_567)).toBe("249 KB");
	});

	it("steps up when rounding reaches the next unit", () => {
		// 1023.999 KB must not print as "1024 KB".
		expect(formatBytes(1024 * 1024 - 1)).toBe("1 MB");
		expect(formatBytes(1024 - 1)).toBe("1023 B");
		expect(formatBytes(1024 ** 3 - 1)).toBe("1 GB");
	});
});
