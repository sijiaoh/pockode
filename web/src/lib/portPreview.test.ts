import { afterEach, describe, expect, it, vi } from "vitest";
import { openPreviewTab, parsePort, previewUrl } from "./portPreview";

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

describe("openPreviewTab", () => {
	const PREVIEW = "https://abc-5173.example.com/";

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function openFakeTab() {
		const tab = {
			opener: window,
			closed: false,
			location: { replace: vi.fn() },
		};
		vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
		return tab;
	}

	it("logs the tab in with the ticket", async () => {
		const tab = openFakeTab();

		expect(openPreviewTab(PREVIEW, () => Promise.resolve("t/1+"))).toBe(true);

		await vi.waitFor(() =>
			expect(tab.location.replace).toHaveBeenCalledWith(
				"https://abc-5173.example.com/__pockode/preview/login?ticket=t%2F1%2B",
			),
		);
	});

	it("sends the tab to the preview itself when there is no ticket", async () => {
		const tab = openFakeTab();

		openPreviewTab(PREVIEW, () => Promise.reject(new Error("Not connected")));

		await vi.waitFor(() =>
			expect(tab.location.replace).toHaveBeenCalledWith(PREVIEW),
		);
	});

	it("reports a blocked tab without asking for a ticket", () => {
		vi.spyOn(window, "open").mockReturnValue(null);
		const getTicket = vi.fn();

		expect(openPreviewTab(PREVIEW, getTicket)).toBe(false);
		expect(getTicket).not.toHaveBeenCalled();
	});
});
