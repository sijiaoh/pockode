import { describe, expect, it } from "vitest";
import { generateNodePassword } from "./nodePassword";

describe("generateNodePassword", () => {
	// A password that is the same every time is not a password. This is the
	// assertion worth having here: length and alphabet are visible in the code,
	// an entropy source that silently stops contributing is not.
	it("produces a different 32-character password each time", () => {
		const passwords = new Set(
			Array.from({ length: 16 }, () => generateNodePassword()),
		);

		expect(passwords.size).toBe(16);
		for (const password of passwords) {
			expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
		}
	});
});
