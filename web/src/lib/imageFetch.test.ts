import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fetchImageBlob,
	IMAGE_FETCH_CONCURRENCY,
	ImageResponseError,
} from "./imageFetch";

vi.mock("../utils/config", () => ({
	getApiBaseUrl: () => "http://localhost:8080",
}));

vi.mock("./authStore", () => ({
	authActions: { getBearer: () => "test-token", logout: () => {} },
}));

let currentWorktree = "feature";

vi.mock("./worktreeStore", () => ({
	worktreeActions: { getCurrent: () => currentWorktree },
}));

function requestedUrl(call = 0): URL {
	return new URL(String(vi.mocked(fetch).mock.calls[call][0]));
}

describe("fetchImageBlob", () => {
	beforeEach(() => {
		currentWorktree = "feature";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("bytes")),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("reads each origin from its endpoint, in the bound worktree, with the bearer header", async () => {
		await fetchImageBlob({ kind: "file", path: "img/a.png" }, "image/png");
		await fetchImageBlob(
			{ kind: "commit", hash: "abc123", path: "img/a.png" },
			"image/png",
		);
		await fetchImageBlob(
			{ kind: "attachment", sessionId: "s1", id: "att-1", worktree: "feature" },
			"image/png",
		);

		const file = requestedUrl(0);
		expect(file.pathname).toBe("/api/files/download");
		expect(Object.fromEntries(file.searchParams)).toEqual({
			path: "img/a.png",
			worktree: "feature",
		});

		const commit = requestedUrl(1);
		expect(commit.pathname).toBe("/api/git/show/file");
		expect(Object.fromEntries(commit.searchParams)).toEqual({
			hash: "abc123",
			path: "img/a.png",
			worktree: "feature",
		});

		const attachment = requestedUrl(2);
		expect(attachment.pathname).toBe("/api/chat/attachments");
		expect(Object.fromEntries(attachment.searchParams)).toEqual({
			session_id: "s1",
			id: "att-1",
			worktree: "feature",
		});

		for (const [, init] of vi.mocked(fetch).mock.calls) {
			expect(new Headers(init?.headers).get("Authorization")).toBe(
				"Bearer test-token",
			);
		}
	});

	it("reads an attachment from the worktree it was described in, not the bound one", async () => {
		await fetchImageBlob(
			{ kind: "attachment", sessionId: "s1", id: "att-1", worktree: "other" },
			"image/png",
		);
		// The main worktree is the absence of the parameter.
		await fetchImageBlob(
			{ kind: "attachment", sessionId: "s1", id: "att-1", worktree: "" },
			"image/png",
		);

		expect(requestedUrl(0).searchParams.get("worktree")).toBe("other");
		expect(requestedUrl(1).searchParams.has("worktree")).toBe(false);
	});

	it("types the bytes as the description's MIME, not the endpoint's", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response("bytes", {
				headers: { "Content-Type": "application/octet-stream" },
			}),
		);

		const blob = await fetchImageBlob(
			{ kind: "file", path: "a.webp" },
			"image/webp; charset=binary",
		);

		expect(blob.type).toBe("image/webp");
		expect(await blob.text()).toBe("bytes");
	});

	it("never types bytes as SVG, which an object URL would run as the app", async () => {
		const blob = await fetchImageBlob(
			{ kind: "file", path: "a.svg" },
			"image/svg+xml",
		);

		expect(blob.type).toBe("application/octet-stream");
	});

	// The wording and the logout on a 401 are `readError`'s, tested with it; the
	// status is what this adds, and what decides whether a read is retried.
	it("carries the status of a refusal along with the server's reason", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "gone", code: "not_found" }), {
				status: 404,
			}),
		);

		const read = fetchImageBlob({ kind: "file", path: "a.png" }, "image/png");

		await expect(read).rejects.toBeInstanceOf(ImageResponseError);
		await expect(read).rejects.toMatchObject({
			status: 404,
			message: expect.stringContaining("File not found"),
		});
	});

	it("keeps no more than IMAGE_FETCH_CONCURRENCY reads in flight", async () => {
		const pending: Array<(response: Response) => void> = [];
		vi.mocked(fetch).mockImplementation(
			() => new Promise<Response>((resolve) => pending.push(resolve)),
		);

		const reads = Array.from({ length: IMAGE_FETCH_CONCURRENCY + 2 }, (_, i) =>
			fetchImageBlob({ kind: "file", path: `${i}.png` }, "image/png"),
		);
		await vi.waitFor(() =>
			expect(fetch).toHaveBeenCalledTimes(IMAGE_FETCH_CONCURRENCY),
		);

		pending[0](new Response("bytes"));
		await reads[0];
		await vi.waitFor(() =>
			expect(fetch).toHaveBeenCalledTimes(IMAGE_FETCH_CONCURRENCY + 1),
		);

		for (let i = 1; i < reads.length; i++) {
			await vi.waitFor(() => expect(pending[i]).toBeDefined());
			pending[i](new Response("bytes"));
		}
		await Promise.all(reads);
	});
});
