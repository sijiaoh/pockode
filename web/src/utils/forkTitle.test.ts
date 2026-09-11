import { describe, expect, it } from "vitest";
import { buildForkTitle } from "./forkTitle";

describe("buildForkTitle", () => {
	it("suffixes the parent's title", () => {
		expect(buildForkTitle("Refactor the store", [])).toBe(
			"Refactor the store (fork)",
		);
	});

	it("takes the lowest number not already in use", () => {
		expect(
			buildForkTitle("Refactor", ["Refactor (fork)", "Refactor (fork 3)"]),
		).toBe("Refactor (fork 2)");
	});

	it("does not stack suffixes when forking a fork", () => {
		// The parent is itself in the list, so its own name is taken too.
		expect(
			buildForkTitle("Refactor (fork 2)", [
				"Refactor",
				"Refactor (fork)",
				"Refactor (fork 2)",
			]),
		).toBe("Refactor (fork 3)");
	});

	it("keeps a title that is nothing but a suffix", () => {
		expect(buildForkTitle("(fork)", [])).toBe("(fork) (fork)");
	});
});
