import { describe, expect, it } from "vitest";
import { generateUUID } from "./uuid";

describe("generateUUID", () => {
	it("returns a valid UUID format", () => {
		const uuid = generateUUID();
		// UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
		const uuidRegex =
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
		expect(uuid).toMatch(uuidRegex);
	});

	it("generates unique UUIDs", () => {
		const uuids = new Set<string>();
		for (let i = 0; i < 100; i++) {
			uuids.add(generateUUID());
		}
		expect(uuids.size).toBe(100);
	});
});
