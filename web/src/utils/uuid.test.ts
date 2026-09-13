import { afterEach, describe, expect, it, vi } from "vitest";
import { generateUUID } from "./uuid";

// UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
const uuidRegex =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("generateUUID", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns a valid UUID format", () => {
		expect(generateUUID()).toMatch(uuidRegex);
	});

	it("generates unique UUIDs", () => {
		const uuids = new Set<string>();
		for (let i = 0; i < 100; i++) {
			uuids.add(generateUUID());
		}
		expect(uuids.size).toBe(100);
	});

	// What an insecure context looks like: `randomUUID` is gated behind one,
	// `getRandomValues` is not. Pockode is served over plain http://<LAN-IP> as a
	// matter of course, and every subscription needs an id to open at all.
	describe("without crypto.randomUUID", () => {
		const realCrypto = globalThis.crypto;
		const insecureCrypto = () => {
			vi.stubGlobal("crypto", {
				getRandomValues: (array: Uint8Array) =>
					realCrypto.getRandomValues(array),
			});
		};

		it("still returns a valid v4 UUID", () => {
			insecureCrypto();
			expect(realCrypto.randomUUID).toBeTypeOf("function");
			expect(crypto.randomUUID).toBeUndefined();
			expect(generateUUID()).toMatch(uuidRegex);
		});

		it("still generates unique UUIDs", () => {
			insecureCrypto();
			const uuids = new Set<string>();
			for (let i = 0; i < 100; i++) {
				uuids.add(generateUUID());
			}
			expect(uuids.size).toBe(100);
		});
	});
});
