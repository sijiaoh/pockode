import { describe, expect, it } from "vitest";
import { formatAgo, formatUptime } from "./time";

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

describe("formatAgo", () => {
	it("coarsens from minutes to days", () => {
		expect(formatAgo(start, at("2026-09-16T10:00:40Z"))).toBe("just now");
		expect(formatAgo(start, at("2026-09-16T10:03:00Z"))).toBe("3 min ago");
		expect(formatAgo(start, at("2026-09-16T12:30:00Z"))).toBe("2 h ago");
		expect(formatAgo(start, at("2026-09-17T11:00:00Z"))).toBe("1 day ago");
		expect(formatAgo(start, at("2026-09-20T10:00:00Z"))).toBe("4 days ago");
	});

	it("gives nothing for an unusable moment", () => {
		expect(formatAgo("not a date", at("2026-09-16T10:14:00Z"))).toBeNull();
	});
});
