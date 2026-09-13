import { describe, expect, it } from "vitest";
import {
	formatContextPercent,
	formatCost,
	formatExactTokens,
	formatTokens,
	totalTokens,
} from "./tokens";

describe("totalTokens", () => {
	it("sums the four counters", () => {
		expect(
			totalTokens({
				input_tokens: 88_412,
				output_tokens: 31_203,
				cache_read_tokens: 1_116_274,
				cache_write_tokens: 12_412,
			}),
		).toBe(1_248_301);
	});
});

describe("formatTokens", () => {
	it("leaves counts below a thousand exact", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(842)).toBe("842");
	});

	it("steps up through thousands and millions", () => {
		expect(formatTokens(1_000)).toBe("1K");
		expect(formatTokens(1_536)).toBe("1.5K");
		expect(formatTokens(1_250_000)).toBe("1.3M");
		expect(formatTokens(12_400_000)).toBe("12.4M");
	});

	it("keeps a decimal only where it says something", () => {
		expect(formatTokens(99_900)).toBe("99.9K");
		expect(formatTokens(128_400)).toBe("128K");
	});

	it("steps up when rounding reaches the next unit", () => {
		expect(formatTokens(999_950)).toBe("1M");
	});
});

describe("formatExactTokens", () => {
	it("groups the exact count", () => {
		expect(formatExactTokens(1_248_301)).toBe("1,248,301");
		expect(formatExactTokens(0)).toBe("0");
	});
});

describe("formatCost", () => {
	it("always shows two decimals, grouped above a thousand", () => {
		expect(formatCost(0)).toBe("$0.00");
		expect(formatCost(3.4159)).toBe("$3.42");
		expect(formatCost(1284.3)).toBe("$1,284.30");
	});

	it("floors a real spend below a cent, so it never reads as nothing", () => {
		expect(formatCost(0.004)).toBe("<$0.01");
		expect(formatCost(0.0099)).toBe("<$0.01");
		expect(formatCost(0.01)).toBe("$0.01");
	});
});

describe("formatContextPercent", () => {
	it("rounds to whole percents", () => {
		expect(formatContextPercent(92_134, 200_000)).toBe("46%");
		expect(formatContextPercent(0, 200_000)).toBe("0%");
	});

	it("keeps a window with something in it from reading as empty", () => {
		expect(formatContextPercent(120, 200_000)).toBe("<1%");
	});

	it("warns at the top end rather than flooring there too", () => {
		expect(formatContextPercent(199_500, 200_000)).toBe("100%");
	});
});
