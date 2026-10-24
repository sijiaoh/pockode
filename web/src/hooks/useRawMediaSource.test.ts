import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveUrl } from "../lib/fileDownload";
import { useWorktreeStore } from "../lib/worktreeStore";
import {
	heldDragDownloadUrl,
	prepareDragDownload,
	saveRawFile,
	saveRawFolder,
} from "./useRawMediaSource";

const rawCapability = vi.fn();
const rawFolderCapability = vi.fn();

vi.mock("../utils/config", () => ({
	getApiBaseUrl: () => "http://localhost:8080",
}));

vi.mock("../lib/wsStore", () => ({
	wsActions: {
		rawCapability: (...args: unknown[]) => rawCapability(...args),
		rawFolderCapability: (...args: unknown[]) => rawFolderCapability(...args),
	},
	useWSStore: { getState: () => ({ status: "connected" }) },
}));

const dragOut = vi.hoisted(() => ({ supported: true }));
vi.mock("../lib/entryDrag", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/entryDrag")>()),
	canDragOutDownload: () => dragOut.supported,
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

describe("saveRawFolder", () => {
	const archive = {
		path: "/api/raw/cap1/",
		expiresAt: Date.now() + 3600e3,
		worktree: "",
	};

	beforeEach(() => {
		rawFolderCapability.mockReset();
		vi.mocked(saveUrl).mockReset();
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		useWorktreeStore.setState({ current: "" });
	});

	// A GET would have the server build and send the whole archive just to be
	// cancelled; a HEAD runs the same checks for nothing.
	it("checks the archive with a HEAD and leaves its name to the server", async () => {
		rawFolderCapability.mockResolvedValue(archive);
		vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 200 }));

		await saveRawFolder("assets", new AbortController().signal);

		expect(rawFolderCapability).toHaveBeenCalledWith("assets");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({
			method: "HEAD",
		});
		expect(saveUrl).toHaveBeenCalledWith(
			expect.stringContaining("/api/raw/cap1/"),
			"",
		);
	});

	// A HEAD refusal has no body, so the reason has to be asked for.
	it.each([
		[
			"a folder that is gone",
			jsonError(404, "not_found", "folder does not exist: assets"),
			"Folder not found — it may have been moved or deleted",
		],
		[
			"a folder over the limit, in the server's words",
			jsonError(
				413,
				"too_large",
				"assets holds more than 2 GiB of files, the most a folder download takes",
			),
			"assets holds more than 2 GiB of files, the most a folder download takes",
		],
		[
			"a name that would unpack elsewhere, which a file's wording would hide",
			jsonError(
				400,
				"invalid_path",
				"assets/a\\b has a backslash in its name, which unpacks as a path on Windows; rename it to download this folder",
			),
			"assets/a\\b has a backslash in its name, which unpacks as a path on Windows; rename it to download this folder",
		],
		[
			"an unreadable file",
			jsonError(
				500,
				"internal",
				"failed to open assets/key: permission denied",
			),
			"Server error: failed to open assets/key: permission denied",
		],
	])("reports %s instead of handing it to the browser", async (_, body, message) => {
		rawFolderCapability.mockResolvedValue(archive);
		vi.mocked(fetch)
			.mockResolvedValueOnce(new Response(null, { status: body.status }))
			.mockResolvedValueOnce(body);

		await expect(
			saveRawFolder("assets", new AbortController().signal),
		).rejects.toThrow(message);
		expect(saveUrl).not.toHaveBeenCalled();
	});

	it("saves nothing from a capability bound to the worktree being left", async () => {
		useWorktreeStore.setState({ current: "feature" });
		rawFolderCapability.mockResolvedValue(archive);

		await expect(
			saveRawFolder("assets", new AbortController().signal),
		).rejects.toThrow("still switching");
		expect(fetch).not.toHaveBeenCalled();
		expect(saveUrl).not.toHaveBeenCalled();
	});

	it("saves nothing once the user has cancelled", async () => {
		const controller = new AbortController();
		rawFolderCapability.mockResolvedValue(archive);
		vi.mocked(fetch).mockImplementationOnce(async () => {
			controller.abort();
			return new Response(null, { status: 200 });
		});

		await expect(saveRawFolder("assets", controller.signal)).rejects.toThrow();
		expect(saveUrl).not.toHaveBeenCalled();
	});
});

describe("a row's drag out of the browser", () => {
	const file = { path: "rec/clip.mov", type: "file" } as const;
	const folder = { path: "assets", type: "dir" } as const;
	let queryClient: QueryClient;

	beforeEach(() => {
		queryClient = new QueryClient();
		rawCapability.mockReset();
		rawFolderCapability.mockReset();
		dragOut.supported = true;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		useWorktreeStore.setState({ current: "" });
	});

	function pressAndWait(entry: { path: string; type: "file" | "dir" }) {
		prepareDragDownload(queryClient, entry);
		return vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
	}

	// `dragstart` cannot wait for a capability, so one never asked for means
	// the drag only moves.
	it("has nothing to save from until the press has asked ahead", async () => {
		rawCapability.mockResolvedValue(capability("cap1"));
		expect(heldDragDownloadUrl(queryClient, file)).toBeNull();

		await pressAndWait(file);

		expect(heldDragDownloadUrl(queryClient, file)).toBe(
			"http://localhost:8080/api/raw/cap1/clip.mov",
		);
		expect(rawCapability).toHaveBeenCalledWith({
			origin: { kind: "file", path: "rec/clip.mov" },
			scope: "file",
		});
	});

	it("saves a folder from the archive Download as zip saves", async () => {
		rawFolderCapability.mockResolvedValue(capability("zip1"));

		await pressAndWait(folder);

		expect(heldDragDownloadUrl(queryClient, folder)).toContain("/zip1/");
		expect(rawFolderCapability).toHaveBeenCalledWith("assets");
		// A file of the same path is a different capability.
		expect(
			heldDragDownloadUrl(queryClient, { path: "assets", type: "file" }),
		).toBeNull();
	});

	// A drag's capability is its own: renewing it never swaps a player's `src`.
	it("leaves the players' capability for the file alone", async () => {
		rawCapability.mockResolvedValue(capability("drag"));
		const playerKey = ["raw-capability", "workspace", "", "file", "file"];
		queryClient.setQueryData([...playerKey, file.path], capability("player"));

		await pressAndWait(file);

		expect(heldDragDownloadUrl(queryClient, file)).toContain("/drag/");
		expect(queryClient.getQueryData([...playerKey, file.path])).toMatchObject({
			path: "/api/raw/player/clip.mov",
		});
	});

	it("asks once per entry, however often it is pressed", async () => {
		rawCapability.mockResolvedValue(capability("cap1"));

		await pressAndWait(file);
		prepareDragDownload(queryClient, file);

		expect(rawCapability).toHaveBeenCalledTimes(1);
	});

	// The server forgets capabilities before they expire — a restart, its cap
	// evicting the oldest — and a drag hands one over unchecked.
	it("asks again on a press long after the last", async () => {
		rawCapability.mockResolvedValueOnce(capability("old"));
		rawCapability.mockResolvedValueOnce(capability("new"));
		await pressAndWait(file);

		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60e3);
		expect(heldDragDownloadUrl(queryClient, file)).toBeNull();
		prepareDragDownload(queryClient, file);

		await vi.waitFor(() =>
			expect(heldDragDownloadUrl(queryClient, file)).toContain("/new/"),
		);
	});

	it("asks again for one about to expire", async () => {
		rawCapability.mockResolvedValueOnce({
			...capability("old"),
			expiresAt: Date.now() + 1000,
		});
		rawCapability.mockResolvedValueOnce(capability("new"));
		await pressAndWait(file);
		expect(heldDragDownloadUrl(queryClient, file)).toBeNull();

		prepareDragDownload(queryClient, file);

		await vi.waitFor(() =>
			expect(heldDragDownloadUrl(queryClient, file)).toContain("/new/"),
		);
	});

	// Asked for during a switch, answered by the connection still on the main
	// worktree.
	it("saves nothing from a capability bound to the worktree being left", async () => {
		rawCapability.mockResolvedValue(capability("old", ""));
		useWorktreeStore.setState({ current: "feature" });

		await pressAndWait(file);

		expect(heldDragDownloadUrl(queryClient, file)).toBeNull();
	});

	it("asks for nothing where the browser cannot save a drag", () => {
		dragOut.supported = false;

		prepareDragDownload(queryClient, file);

		expect(rawCapability).not.toHaveBeenCalled();
		expect(heldDragDownloadUrl(queryClient, file)).toBeNull();
	});
});
