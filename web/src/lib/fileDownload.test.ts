import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readError, saveBlob, saveUrl } from "./fileDownload";

vi.mock("../utils/config", () => ({
	getApiBaseUrl: () => "http://localhost:8080",
}));

const logout = vi.fn();

vi.mock("./authStore", () => ({
	authActions: { getBearer: () => "test-token", logout: () => logout() },
}));

function jsonError(status: number, code: string, message: string) {
	return new Response(JSON.stringify({ error: message, code }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("readError", () => {
	beforeEach(() => {
		logout.mockClear();
	});

	it.each([
		["not_found", "File not found — it may have been moved or deleted"],
		["invalid_path", "Invalid file path"],
		["not_a_file", "This path is not a regular file"],
		["worktree_not_found", "Worktree not found"],
		[
			"outside_scope",
			"This file can't be read from here — it may link to outside the project, or not be readable",
		],
	])("phrases the %s failure for the user", async (code, expected) => {
		const error = await readError(jsonError(404, code, "not found: gone.txt"));

		expect(error.message).toBe(expected);
	});

	it("keeps the server's detail on an internal failure", async () => {
		const error = await readError(
			jsonError(500, "internal", "failed to open a.txt: permission denied"),
		);

		expect(error.message).toBe(
			"Server error: failed to open a.txt: permission denied",
		);
	});

	it("passes an unrecognised code's message through unchanged", async () => {
		const error = await readError(
			jsonError(400, "brand_new_code", "something the client has not heard of"),
		);

		expect(error.message).toBe("something the client has not heard of");
	});

	it("falls back to the status when the body is not the API's JSON", async () => {
		const error = await readError(
			new Response("<html>Bad Gateway</html>", { status: 502 }),
		);

		expect(error.message).toBe("Download failed with HTTP 502");
	});

	it("ends the session when the server rejects the token", async () => {
		// The auth middleware answers in plain text, so there is no code to map;
		// a rejected token is the end of the session either way.
		const error = await readError(
			new Response("Invalid token", { status: 401 }),
		);

		expect(error.message).toBe("Your session has expired. Sign in again.");
		expect(logout).toHaveBeenCalled();
	});
});

describe("saving to the device (saveBlob, saveUrl)", () => {
	const createObjectURL = vi.fn(() => "blob:fake");
	const revokeObjectURL = vi.fn();
	const clicks: { download: string; href: string | null }[] = [];
	// jsdom implements neither, so they are installed rather than spied on.
	const originalCreate = URL.createObjectURL;
	const originalRevoke = URL.revokeObjectURL;

	beforeEach(() => {
		clicks.length = 0;
		createObjectURL.mockClear();
		revokeObjectURL.mockClear();
		URL.createObjectURL = createObjectURL;
		URL.revokeObjectURL = revokeObjectURL;
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
			function click(this: HTMLAnchorElement) {
				clicks.push({
					download: this.download,
					href: this.getAttribute("href"),
				});
			},
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		URL.createObjectURL = originalCreate;
		URL.revokeObjectURL = originalRevoke;
	});

	it("streams a URL as an attachment under the name given", () => {
		saveUrl("/api/raw/cap/clip.mov", "Screen Recording.mov");

		expect(clicks).toEqual([
			{
				download: "Screen Recording.mov",
				href: `${window.location.origin}/api/raw/cap/clip.mov?download=1`,
			},
		]);
		// The link is a way of handing the URL over, not part of the page.
		expect(document.querySelector("a")).toBeNull();
	});

	// The object URL is same-origin with the app: if a browser opened an SVG
	// under its own type instead of saving it, its scripts would run as the app.
	it("saves a blob as bytes, whatever type it carried", () => {
		saveBlob(new Blob(["<svg/>"], { type: "image/svg+xml" }), "a.svg");

		const [[saved]] = createObjectURL.mock.calls as unknown as [[Blob]];
		expect(saved.type).toBe("application/octet-stream");
		expect(clicks).toEqual([{ download: "a.svg", href: "blob:fake" }]);
	});

	it("releases the object URL once the browser has taken the blob", () => {
		vi.useFakeTimers();

		saveBlob(new Blob(["hi"]), "a.txt");
		expect(revokeObjectURL).not.toHaveBeenCalled();

		vi.runAllTimers();
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
		vi.useRealTimers();
	});
});
