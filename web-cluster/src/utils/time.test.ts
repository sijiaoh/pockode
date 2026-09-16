import { describe, expect, it } from "vitest";
import { formatUptime } from "./time";

const start = "2026-09-16T10:00:00Z";
const at = (iso: string) => new Date(iso).getTime();

describe("formatUptime", () => {
	it("reports minutes, then hours, then days", () => {
		expect(formatUptime(start, at("2026-09-16T10:14:00Z"))).toBe("14m");
		expect(formatUptime(start, at("2026-09-16T12:14:00Z"))).toBe("2h 14m");
		expect(formatUptime(start, at("2026-09-19T14:00:00Z"))).toBe("3d 4h");
	});

	it("says <1m below a minute", () => {
		expect(formatUptime(start, at("2026-09-16T10:00:30Z"))).toBe("<1m");
	});

	it("gives nothing for an unusable or future start", () => {
		expect(formatUptime("not a date", at("2026-09-16T10:14:00Z"))).toBeNull();
		expect(formatUptime(start, at("2026-09-16T09:00:00Z"))).toBeNull();
	});
});
