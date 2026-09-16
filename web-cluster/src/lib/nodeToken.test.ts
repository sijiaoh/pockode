import { describe, expect, it } from "vitest";
import { generateNodeToken } from "./nodeToken";

describe("generateNodeToken", () => {
	// A token that is the same every time is not a token. This is the assertion
	// worth having here: length and alphabet are visible in the code, an
	// entropy source that silently stops contributing is not.
	it("produces a different 32-character token each time", () => {
		const tokens = new Set(
			Array.from({ length: 16 }, () => generateNodeToken()),
		);

		expect(tokens.size).toBe(16);
		for (const token of tokens) {
			expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
		}
	});
});
