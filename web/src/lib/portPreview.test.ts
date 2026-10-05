import { afterEach, describe, expect, it, vi } from "vitest";
import { openInNewTab, parsePort, previewUrl } from "./portPreview";

describe("parsePort", () => {
	it.each([
		["5173", 5173],
		["1", 1],
		["65535", 65535],
		[" 8080 ", 8080],
		["05173", 5173],
	])("accepts %j as %d", (input, port) => {
		expect(parsePort(input)).toBe(port);
	});

	it.each([
		"",
		"0",
		"00000",
		"65536",
		"51a3",
		"-1",
		"1e3",
		"5173.0",
	])("rejects %j", (input) => {
		expect(parsePort(input)).toBeNull();
	});
});

describe("previewUrl", () => {
	it("adds the port to the first label", () => {
		expect(previewUrl("https://abc123.cloud.pockode.com", 5173)).toBe(
			"https://abc123-5173.cloud.pockode.com/",
		);
	});

	it("keeps the scheme and the relay's own port, and drops any path", () => {
		expect(previewUrl("http://abc.local.example.com:8443/app?x=1", 80)).toBe(
			"http://abc-80.local.example.com:8443/",
		);
	});
});

describe("openInNewTab", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("opens the address in a new tab with its opener cut", () => {
		const tab = { opener: window };
		const open = vi
			.spyOn(window, "open")
			.mockReturnValue(tab as unknown as Window);

		expect(openInNewTab("https://abc-5173.example.com/")).toBe(true);
		expect(open).toHaveBeenCalledWith(
			"https://abc-5173.example.com/",
			"_blank",
		);
		expect(tab.opener).toBeNull();
	});

	it("reports a blocked tab", () => {
		vi.spyOn(window, "open").mockReturnValue(null);

		expect(openInNewTab("https://abc-5173.example.com/")).toBe(false);
	});
});
