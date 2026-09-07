import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAbortError } from "./api";
import {
	DOWNLOAD_CHUNK_SIZE,
	downloadFile,
	fetchFileBlob,
} from "./fileDownload";

vi.mock("../utils/config", () => ({
	getApiBaseUrl: () => "http://localhost:8080",
}));

const logout = vi.fn();

vi.mock("./authStore", () => ({
	authActions: { getToken: () => "test-token", logout: () => logout() },
}));

/** A 206 carrying `body` as the bytes `[start, start + body.length)` of `total`. */
function partial(
	body: string,
	start: number,
	total: number,
	modified?: string,
) {
	const headers = new Headers({
		"Content-Range": `bytes ${start}-${start + body.length - 1}/${total}`,
	});
	if (modified) headers.set("Last-Modified", modified);
	return new Response(body, { status: 206, headers });
}

function jsonError(status: number, code: string, message: string) {
	return new Response(JSON.stringify({ error: message, code }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function requestHeaders(call: number): Headers {
	const [, init] = vi.mocked(fetch).mock.calls[call];
	return new Headers(init?.headers);
}

describe("fetchFileBlob", () => {
	beforeEach(() => {
		logout.mockClear();
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("authenticates and names the worktree it reads from", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(partial("hi", 0, 2));

		await fetchFileBlob({ path: "src/app.ts", worktree: "feature" });

		const [url] = vi.mocked(fetch).mock.calls[0];
		expect(url).toBe(
			"http://localhost:8080/api/files/download?path=src%2Fapp.ts&worktree=feature",
		);
		expect(requestHeaders(0).get("Authorization")).toBe("Bearer test-token");
	});

	it("omits the worktree parameter for the main worktree", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(partial("hi", 0, 2));

		await fetchFileBlob({ path: "a.txt", worktree: "" });

		expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
			"http://localhost:8080/api/files/download?path=a.txt",
		);
	});

	it("assembles a file larger than one chunk from ranged requests", async () => {
		const total = DOWNLOAD_CHUNK_SIZE + 3;
		const head = "a".repeat(DOWNLOAD_CHUNK_SIZE);
		vi.mocked(fetch)
			.mockResolvedValueOnce(
				partial(head, 0, total, "Mon, 01 Jan 2024 00:00:00 GMT"),
			)
			.mockResolvedValueOnce(partial("bcd", DOWNLOAD_CHUNK_SIZE, total));

		const blob = await fetchFileBlob({ path: "big.bin", worktree: "" });

		expect(await blob.text()).toBe(`${head}bcd`);
		expect(requestHeaders(0).get("Range")).toBe(
			`bytes=0-${DOWNLOAD_CHUNK_SIZE - 1}`,
		);
		expect(requestHeaders(1).get("Range")).toBe(
			`bytes=${DOWNLOAD_CHUNK_SIZE}-${2 * DOWNLOAD_CHUNK_SIZE - 1}`,
		);
		// Nothing to be conditional on yet: a precondition on the first request
		// would refuse every download outright.
		expect(requestHeaders(0).get("If-Unmodified-Since")).toBeNull();
		// Without it the second chunk could come from a different version of the
		// file and be spliced onto the first without anyone noticing.
		expect(requestHeaders(1).get("If-Unmodified-Since")).toBe(
			"Mon, 01 Jan 2024 00:00:00 GMT",
		);
	});

	it("follows the server's own chunk end when it sends less than asked", async () => {
		const total = DOWNLOAD_CHUNK_SIZE;
		const head = "a".repeat(DOWNLOAD_CHUNK_SIZE - 2);
		vi.mocked(fetch)
			.mockResolvedValueOnce(partial(head, 0, total))
			.mockResolvedValueOnce(partial("bc", DOWNLOAD_CHUNK_SIZE - 2, total));

		const blob = await fetchFileBlob({ path: "big.bin", worktree: "" });

		expect(await blob.text()).toBe(`${head}bc`);
		// Resuming from the requested end rather than the delivered one would skip
		// the two bytes the server held back.
		expect(requestHeaders(1).get("Range")).toBe(
			`bytes=${DOWNLOAD_CHUNK_SIZE - 2}-${2 * DOWNLOAD_CHUNK_SIZE - 3}`,
		);
	});

	it("reports a file rewritten between chunks, which the precondition refuses", async () => {
		const total = DOWNLOAD_CHUNK_SIZE + 3;
		vi.mocked(fetch)
			.mockResolvedValueOnce(
				partial(
					"a".repeat(DOWNLOAD_CHUNK_SIZE),
					0,
					total,
					"Mon, 01 Jan 2024 00:00:00 GMT",
				),
			)
			// What the server answers a failed If-Unmodified-Since with — bytes
			// rather than a second copy of the whole file.
			.mockResolvedValueOnce(new Response("", { status: 412 }));

		await expect(
			fetchFileBlob({ path: "big.bin", worktree: "" }),
		).rejects.toThrow(/changed while it was being downloaded/);
	});

	it("takes a 200 as the whole file, discarding what came before it", async () => {
		const total = DOWNLOAD_CHUNK_SIZE + 3;
		vi.mocked(fetch)
			.mockResolvedValueOnce(partial("a".repeat(DOWNLOAD_CHUNK_SIZE), 0, total))
			.mockResolvedValueOnce(new Response("rewritten", { status: 200 }));

		const blob = await fetchFileBlob({ path: "big.bin", worktree: "" });

		expect(await blob.text()).toBe("rewritten");
	});

	// An empty file satisfies no range at all, and a server may say so either
	// way, so both answers have to produce the same empty file.
	it.each([
		["a 200 with no body", () => new Response("", { status: 200 })],
		[
			"a 416 reporting zero bytes",
			() =>
				new Response("", {
					status: 416,
					headers: { "Content-Range": "bytes */0" },
				}),
		],
	])("downloads an empty file answered with %s", async (_name, response) => {
		vi.mocked(fetch).mockResolvedValueOnce(response());

		const blob = await fetchFileBlob({ path: "empty.txt", worktree: "" });

		expect(blob.size).toBe(0);
	});

	it("says so when a refused range comes with no size to explain it", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 416 }));

		await expect(
			fetchFileBlob({ path: "a.txt", worktree: "" }),
		).rejects.toThrow(/refused the bytes from 0 onward/);
	});

	it("reports a file that shrank mid-download instead of saving a truncated one", async () => {
		const total = DOWNLOAD_CHUNK_SIZE + 3;
		vi.mocked(fetch)
			.mockResolvedValueOnce(partial("a".repeat(DOWNLOAD_CHUNK_SIZE), 0, total))
			.mockResolvedValueOnce(
				new Response("", {
					status: 416,
					headers: { "Content-Range": "bytes */10" },
				}),
			);

		await expect(
			fetchFileBlob({ path: "big.bin", worktree: "" }),
		).rejects.toThrow(/changed while it was being downloaded/);
	});

	it("reports a file whose size changed between chunks", async () => {
		const total = DOWNLOAD_CHUNK_SIZE + 3;
		vi.mocked(fetch)
			.mockResolvedValueOnce(partial("a".repeat(DOWNLOAD_CHUNK_SIZE), 0, total))
			.mockResolvedValueOnce(partial("bcd", DOWNLOAD_CHUNK_SIZE, total + 100));

		await expect(
			fetchFileBlob({ path: "big.bin", worktree: "" }),
		).rejects.toThrow(/changed while it was being downloaded/);
	});

	it.each([
		["not_found", "File not found — it may have been moved or deleted"],
		["invalid_path", "Invalid file path"],
		["not_a_file", "This path is not a regular file"],
		["worktree_not_found", "Worktree not found"],
	])("phrases the %s failure for the user", async (code, expected) => {
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonError(404, code, "not found: gone.txt"),
		);

		await expect(
			fetchFileBlob({ path: "gone.txt", worktree: "" }),
		).rejects.toThrow(expected);
	});

	it("keeps the server's detail on an internal failure", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonError(500, "internal", "failed to open a.txt: permission denied"),
		);

		await expect(
			fetchFileBlob({ path: "a.txt", worktree: "" }),
		).rejects.toThrow("Server error: failed to open a.txt: permission denied");
	});

	it("passes an unrecognised code's message through unchanged", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonError(400, "brand_new_code", "something the client has not heard of"),
		);

		await expect(
			fetchFileBlob({ path: "a.txt", worktree: "" }),
		).rejects.toThrow("something the client has not heard of");
	});

	it("falls back to the status when the body is not the API's JSON", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response("<html>Bad Gateway</html>", { status: 502 }),
		);

		await expect(
			fetchFileBlob({ path: "a.txt", worktree: "" }),
		).rejects.toThrow("Download failed with HTTP 502");
	});

	it("ends the session when the server rejects the token", async () => {
		// The auth middleware answers in plain text, so there is no code to map;
		// a rejected token is the end of the session either way.
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response("Invalid token", { status: 401 }),
		);

		await expect(
			fetchFileBlob({ path: "a.txt", worktree: "" }),
		).rejects.toThrow("Your session has expired. Sign in again.");
		expect(logout).toHaveBeenCalled();
	});

	it("refuses a chunk that does not start where it was asked to", async () => {
		const total = DOWNLOAD_CHUNK_SIZE + 3;
		vi.mocked(fetch)
			.mockResolvedValueOnce(partial("a".repeat(DOWNLOAD_CHUNK_SIZE), 0, total))
			// Appending this would produce a file that looks whole and is not.
			.mockResolvedValueOnce(partial("bcd", DOWNLOAD_CHUNK_SIZE + 100, total));

		await expect(
			fetchFileBlob({ path: "big.bin", worktree: "" }),
		).rejects.toThrow(/when asked for 4194304 onward/);
	});

	it("stops mid-file once the caller aborts, on every chunk", async () => {
		const controller = new AbortController();
		const total = 4 * DOWNLOAD_CHUNK_SIZE;
		// Stands in for fetch's own contract: it rejects rather than sending a
		// request once the signal it was handed has fired.
		vi.mocked(fetch).mockImplementation(async (_url, init) => {
			if (init?.signal?.aborted) {
				const aborted = new Error("The operation was aborted.");
				aborted.name = "AbortError";
				throw aborted;
			}
			controller.abort();
			return partial("a".repeat(DOWNLOAD_CHUNK_SIZE), 0, total);
		});

		const error = await fetchFileBlob({
			path: "big.bin",
			worktree: "",
			signal: controller.signal,
		}).catch((e: unknown) => e);

		expect(isAbortError(error)).toBe(true);
		// One chunk, then the abort stops the next: without the signal reaching
		// every request, the loop would run the file to its end.
		expect(fetch).toHaveBeenCalledTimes(2);
		for (const [, init] of vi.mocked(fetch).mock.calls) {
			expect(init?.signal).toBe(controller.signal);
		}
	});
});

describe("downloadFile", () => {
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
		vi.stubGlobal("fetch", vi.fn());
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
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		URL.createObjectURL = originalCreate;
		URL.revokeObjectURL = originalRevoke;
	});

	it("saves the file under its name in the workspace", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(partial("hi", 0, 2));

		await downloadFile({ path: "src/nested/app.ts", worktree: "" });

		expect(clicks).toEqual([{ download: "app.ts", href: "blob:fake" }]);
		// The link is a way of handing the blob over, not part of the page.
		expect(document.querySelector("a")).toBeNull();
	});

	it("does not save a file the user cancelled on the last chunk", async () => {
		const controller = new AbortController();
		vi.mocked(fetch).mockImplementationOnce(async () => {
			// The bytes arrive, and only then does the user press Cancel. Aborting a
			// fetch that has already settled does nothing, so nothing but an explicit
			// check stands between the cancellation and a saved file.
			controller.abort();
			return partial("hi", 0, 2);
		});

		await downloadFile({
			path: "a.txt",
			worktree: "",
			signal: controller.signal,
		});

		expect(clicks).toEqual([]);
	});

	it("releases the object URL once the browser has taken the blob", async () => {
		vi.useFakeTimers();
		vi.mocked(fetch).mockResolvedValueOnce(partial("hi", 0, 2));

		await downloadFile({ path: "a.txt", worktree: "" });
		expect(revokeObjectURL).not.toHaveBeenCalled();

		vi.runAllTimers();
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
		vi.useRealTimers();
	});
});
