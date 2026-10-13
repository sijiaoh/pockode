import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveUrl } from "../lib/fileDownload";
import { useWorktreeStore } from "../lib/worktreeStore";
import { saveRawFile } from "./useRawMediaSource";

const rawCapability = vi.fn();

vi.mock("../utils/config", () => ({
	getApiBaseUrl: () => "http://localhost:8080",
}));

vi.mock("../lib/wsStore", () => ({
	wsActions: { rawCapability: (...args: unknown[]) => rawCapability(...args) },
	useWSStore: { getState: () => ({ status: "connected" }) },
}));

vi.mock("../lib/fileDownload", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/fileDownload")>()),
	saveUrl: vi.fn(),
}));

const origin = { kind: "file", path: "rec/clip.mov" } as const;

/** A capability bound to `worktree`; the store starts on the main one. */
function capability(name: string, worktree = "") {
	return {
		path: `/api/raw/${name}/clip.mov`,
		expiresAt: Date.now() + 3600e3,
		worktree,
	};
}

function jsonError(status: number, code: string, message: string) {
	return new Response(JSON.stringify({ error: message, code }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("saveRawFile", () => {
	let queryClient: QueryClient;

	beforeEach(() => {
		queryClient = new QueryClient();
		rawCapability.mockReset();
		vi.mocked(saveUrl).mockReset();
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		useWorktreeStore.setState({ current: "" });
	});

	it("hands the browser the capability once its first byte is served", async () => {
		rawCapability.mockResolvedValue(capability("cap1"));
		vi.mocked(fetch).mockResolvedValueOnce(new Response("x", { status: 206 }));

		await saveRawFile(queryClient, origin, "clip.mov");

		expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
			"http://localhost:8080/api/raw/cap1/clip.mov",
		);
		expect(saveUrl).toHaveBeenCalledWith(
			"http://localhost:8080/api/raw/cap1/clip.mov",
			"clip.mov",
		);
	});

	// Past the click nothing comes back, so a refusal is only ever reported
	// from here.
	it("reports a refused file instead of handing it to the browser", async () => {
		rawCapability.mockResolvedValue(capability("cap1"));
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonError(404, "not_found", "not found: rec/clip.mov"),
		);

		await expect(saveRawFile(queryClient, origin, "clip.mov")).rejects.toThrow(
			"File not found — it may have been moved or deleted",
		);
		expect(saveUrl).not.toHaveBeenCalled();
	});

	it("renews a capability that died with its session, once", async () => {
		rawCapability
			.mockResolvedValueOnce(capability("dead"))
			.mockResolvedValueOnce(capability("cap2"));
		vi.mocked(fetch)
			.mockResolvedValueOnce(
				jsonError(404, "capability_not_found", "capability is unknown"),
			)
			.mockResolvedValueOnce(new Response("x", { status: 206 }));

		await saveRawFile(queryClient, origin, "clip.mov");

		expect(saveUrl).toHaveBeenCalledWith(
			"http://localhost:8080/api/raw/cap2/clip.mov",
			"clip.mov",
		);
	});

	it("reports a renewed capability that is refused as well", async () => {
		rawCapability
			.mockResolvedValueOnce(capability("dead"))
			.mockResolvedValueOnce(capability("dead2"));
		vi.mocked(fetch).mockImplementation(async () =>
			jsonError(404, "capability_not_found", "capability is unknown"),
		);

		await expect(saveRawFile(queryClient, origin, "clip.mov")).rejects.toThrow(
			"capability is unknown",
		);
		expect(rawCapability).toHaveBeenCalledTimes(2);
		expect(saveUrl).not.toHaveBeenCalled();
	});

	it("reports a server it cannot reach", async () => {
		rawCapability.mockResolvedValue(capability("cap1"));
		vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));

		await expect(saveRawFile(queryClient, origin, "clip.mov")).rejects.toThrow(
			"Failed to fetch",
		);
		expect(saveUrl).not.toHaveBeenCalled();
	});

	// The store's worktree moves before the connection does, and the server
	// answers concurrently: a capability asked for during a switch may be
	// bound to the worktree being left.
	it("asks again for a capability bound to the worktree being left", async () => {
		rawCapability
			.mockResolvedValueOnce(capability("old", "feature"))
			.mockResolvedValueOnce(capability("new"));
		vi.mocked(fetch).mockImplementation(
			async () => new Response("x", { status: 206 }),
		);

		await saveRawFile(queryClient, origin, "clip.mov");

		expect(saveUrl).toHaveBeenCalledOnce();
		expect(saveUrl).toHaveBeenCalledWith(
			"http://localhost:8080/api/raw/new/clip.mov",
			"clip.mov",
		);
	});

	it("saves nothing while the switch has still not landed", async () => {
		rawCapability.mockResolvedValue(capability("old", "feature"));
		vi.mocked(fetch).mockImplementation(
			async () => new Response("x", { status: 206 }),
		);

		await expect(saveRawFile(queryClient, origin, "clip.mov")).rejects.toThrow(
			"The worktree is still switching",
		);
		expect(saveUrl).not.toHaveBeenCalled();
	});

	it("saves nothing once the user has switched worktree meanwhile", async () => {
		rawCapability.mockResolvedValue(capability("cap1"));
		vi.mocked(fetch).mockImplementationOnce(async () => {
			useWorktreeStore.setState({ current: "feature" });
			return new Response("x", { status: 206 });
		});

		await expect(saveRawFile(queryClient, origin, "clip.mov")).rejects.toThrow(
			"The worktree changed",
		);
		expect(saveUrl).not.toHaveBeenCalled();
	});

	it("saves nothing once the user has cancelled", async () => {
		const controller = new AbortController();
		rawCapability.mockResolvedValue(capability("cap1"));
		vi.mocked(fetch).mockImplementationOnce(async () => {
			// The byte arrives, and only then does the user press Cancel: aborting
			// a fetch that has settled does nothing on its own.
			controller.abort();
			return new Response("x", { status: 206 });
		});

		const error = await saveRawFile(
			queryClient,
			origin,
			"clip.mov",
			controller.signal,
		).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).name).toBe("AbortError");
		expect(saveUrl).not.toHaveBeenCalled();
	});
});
