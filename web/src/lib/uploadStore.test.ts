import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type FolderContents,
	type FolderUploadRequest,
	UploadError,
	type UploadRequest,
	uploadFile,
	uploadFolder,
} from "./fileUpload";
import {
	onFileUploaded,
	storedSummary,
	UPLOAD_CONCURRENCY,
	uploadActions,
	useUploadStore,
} from "./uploadStore";
import { worktreeActions } from "./worktreeStore";

vi.mock("./fileUpload", async (importOriginal) => ({
	...(await importOriginal<typeof import("./fileUpload")>()),
	uploadFile: vi.fn(),
	uploadFolder: vi.fn(),
}));

let maxUploadSize = 0;

vi.mock("./wsStore", () => ({
	useWSStore: { getState: () => ({ maxUploadSize }) },
}));

interface InFlight {
	request: UploadRequest;
	resolve: () => void;
	reject: (error: unknown) => void;
}

let inFlight: InFlight[] = [];

interface FolderInFlight {
	request: FolderUploadRequest;
	resolve: () => void;
	reject: (error: unknown) => void;
}

let foldersInFlight: FolderInFlight[] = [];

/** Lets the promise chain around one upload settle. */
async function flush() {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

function file(name: string, size = 4): File {
	return new File(["x".repeat(size)], name);
}

function items() {
	return useUploadStore.getState().items;
}

function statuses() {
	return items().map((item) => item.status);
}

function sentNames() {
	return inFlight.map((call) => call.request.name);
}

describe("uploadStore", () => {
	beforeEach(() => {
		inFlight = [];
		foldersInFlight = [];
		maxUploadSize = 0;
		uploadActions.reset();
		worktreeActions.setCurrent("");
		vi.mocked(uploadFolder).mockImplementation(
			(request) =>
				new Promise((resolve, reject) => {
					foldersInFlight.push({ request, resolve, reject });
				}),
		);
		vi.mocked(uploadFile).mockImplementation(
			(request) =>
				new Promise((resolve, reject) => {
					inFlight.push({ request, resolve, reject });
				}),
		);
	});

	afterEach(() => {
		uploadActions.reset();
	});

	it("holds the queue to its concurrency limit and starts the next as one lands", async () => {
		const names = ["a", "b", "c", "d"].map((n) => `${n}.txt`);
		uploadActions.enqueue(
			names.map((name) => ({ file: file(name), destPath: "" })),
		);

		expect(inFlight).toHaveLength(UPLOAD_CONCURRENCY);
		expect(statuses()).toEqual([
			"uploading",
			"uploading",
			"uploading",
			"queued",
		]);

		inFlight[0].resolve();
		await flush();

		expect(sentNames()).toEqual(names);
		expect(statuses()).toEqual(["done", "uploading", "uploading", "uploading"]);
	});

	it("tells the destination it changed, so a collapsed folder still shows the file", async () => {
		const seen: string[] = [];
		const stop = onFileUploaded((destPath) => seen.push(destPath));

		uploadActions.enqueue([{ file: file("a.txt"), destPath: "src/assets" }]);
		inFlight[0].resolve();
		await flush();

		expect(seen).toEqual(["src/assets"]);
		stop();
	});

	it("records progress only where it can be seen", () => {
		uploadActions.enqueue([{ file: file("a.txt"), destPath: "" }]);
		const report = inFlight[0].request.onProgress;

		report?.(0.004);
		// Every write re-renders the Files tab, and the queue shows whole
		// percentages: a big file over a slow link would report thousands of times.
		expect(items()[0].progress).toBe(0);

		report?.(0.5);
		expect(items()[0].progress).toBe(0.5);
	});

	it("carries a failure's own wording and whether it is worth retrying", async () => {
		uploadActions.enqueue([{ file: file("a.txt"), destPath: "" }]);
		inFlight[0].reject(
			new UploadError("a.txt already exists", {
				code: "conflict",
				canRetry: false,
			}),
		);
		await flush();

		expect(items()[0]).toMatchObject({
			status: "failed",
			error: "a.txt already exists",
			canRetry: false,
			// Both resolutions are offered: the endpoint answers 409 for a folder
			// of that name exactly as it does for a file.
			conflict: "file",
		});
	});

	it("counts a file the failed request had already stored as uploaded", async () => {
		uploadActions.enqueue([{ file: file("a.txt"), destPath: "" }]);
		// One file per request, so `written` naming it means it is on disk in
		// full; reporting a failure would ask for it to be sent twice.
		inFlight[0].reject(
			new UploadError("The upload was cut short", {
				code: "invalid_request",
				written: ["a.txt"],
			}),
		);
		await flush();

		expect(items()[0].status).toBe("done");
	});

	it("refuses a file this connection cannot carry without sending it", () => {
		maxUploadSize = 8;
		uploadActions.enqueue([{ file: file("big.bin", 16), destPath: "" }]);

		// On a relay there is no 413 to fall back on: the request would overrun
		// the tunnel's read limit and drop it.
		expect(inFlight).toHaveLength(0);
		expect(items()[0]).toMatchObject({
			status: "failed",
			error: "Too large (max 8 B)",
			canRetry: false,
		});
	});

	it("keeps a cancelled upload cancelled when its response finally arrives", async () => {
		uploadActions.enqueue([{ file: file("a.txt"), destPath: "" }]);
		uploadActions.cancelAll();

		expect(items()[0].status).toBe("cancelled");
		expect(inFlight[0].request.signal?.aborted).toBe(true);

		inFlight[0].resolve();
		await flush();

		expect(items()[0].status).toBe("cancelled");
	});

	it("drops uploads bound for the worktree that was just left", async () => {
		uploadActions.enqueue([{ file: file("a.txt"), destPath: "" }]);

		worktreeActions.setCurrent("feature");
		await flush();

		// Their worktree travels in the request, so one still running would write
		// into a tree the user has already left.
		expect(items()[0]).toMatchObject({
			status: "cancelled",
			error: "Cancelled — worktree changed",
			worktree: "",
		});
	});

	it("never sends a file at a folder of the same name, and renames it on request", async () => {
		uploadActions.enqueue([
			{ file: file("icons"), destPath: "assets", blockedBy: "folder" },
		]);

		expect(inFlight).toHaveLength(0);
		expect(items()[0]).toMatchObject({
			status: "failed",
			error: "A folder with this name exists",
			conflict: "folder",
			canRetry: false,
		});

		uploadActions.retry(items()[0].id, { name: "icons (1)" });

		expect(sentNames()).toEqual(["icons (1)"]);
		expect(items()[0].status).toBe("uploading");
	});

	it("retries only the failures that a second attempt could get past", async () => {
		uploadActions.enqueue([
			{ file: file("a.txt"), destPath: "" },
			{ file: file("b.txt"), destPath: "" },
		]);
		inFlight[0].reject(new UploadError("Connection lost"));
		inFlight[1].reject(
			new UploadError("Too large (max 7 MB)", {
				code: "too_large",
				canRetry: false,
			}),
		);
		await flush();

		uploadActions.retryFailed();

		expect(sentNames()).toEqual(["a.txt", "b.txt", "a.txt"]);
		expect(statuses()).toEqual(["uploading", "failed"]);
	});

	it("clears itself once everything has landed, and not before", async () => {
		vi.useFakeTimers();
		try {
			uploadActions.enqueue([
				{ file: file("a.txt"), destPath: "" },
				{ file: file("b.txt"), destPath: "" },
			]);

			inFlight[0].resolve();
			await flush();
			vi.advanceTimersByTime(5000);
			// One is still running; a queue that clears now takes its progress
			// off screen with it.
			expect(items()).toHaveLength(2);

			inFlight[1].resolve();
			await flush();
			vi.advanceTimersByTime(5000);

			expect(items()).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a failure on screen until it is dismissed", async () => {
		vi.useFakeTimers();
		try {
			uploadActions.enqueue([{ file: file("a.txt"), destPath: "" }]);
			inFlight[0].reject(new UploadError("Connection lost"));
			await flush();
			vi.advanceTimersByTime(5000);

			expect(items()).toHaveLength(1);

			uploadActions.dismiss();

			expect(items()).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("leaves a running upload alone when the finished ones are dismissed", async () => {
		uploadActions.enqueue([
			{ file: file("a.txt"), destPath: "" },
			{ file: file("b.txt"), destPath: "" },
		]);
		inFlight[0].resolve();
		await flush();

		uploadActions.dismiss();

		expect(items()).toHaveLength(1);
		expect(items()[0]).toMatchObject({ name: "b.txt", status: "uploading" });
	});

	describe("folders", () => {
		function contents(...paths: string[]): FolderContents {
			return {
				files: paths.map((path) => ({ file: file(path), path })),
				dirs: [],
			};
		}

		/** A folder that has been read and is ready to go, as the tab hands it over. */
		function sendFolder(name: string, folder: FolderContents, merge = false) {
			const [{ id }] = uploadActions.addFolders([{ name, destPath: "src" }]);
			uploadActions.holdFolder(id, folder);
			uploadActions.queueFolder(id, { overwrite: merge });
			return id;
		}

		it("is unfinished while it is read, and the header ✕ stops the reading", () => {
			const [{ id, signal }] = uploadActions.addFolders([
				{ name: "assets", destPath: "src" },
			]);
			expect(items()[0]).toMatchObject({ id, status: "reading" });

			uploadActions.cancelAll();

			expect(signal.aborted).toBe(true);
			expect(items()[0].status).toBe("cancelled");
			expect(storedSummary(items()[0])).toBe("Nothing was uploaded");
			// A walk that finishes anyway does not bring the folder back.
			uploadActions.holdFolder(id, contents("a.txt"));
			expect(items()[0].status).toBe("cancelled");
		});

		it("refuses a folder over the limit as a whole, before sending any of it", () => {
			maxUploadSize = 6;
			const [{ id }] = uploadActions.addFolders([
				{ name: "assets", destPath: "src" },
			]);

			expect(uploadActions.holdFolder(id, contents("a.txt", "b.txt"))).toBe(
				false,
			);

			// The limit is per request, and a folder is one request.
			expect(foldersInFlight).toHaveLength(0);
			expect(items()[0]).toMatchObject({
				status: "failed",
				error: "assets is 8 B (max 6 B)",
				canRetry: false,
			});
		});

		it("says how many files a failed merge left behind, and sends only the rest again", async () => {
			sendFolder("assets", contents("a.txt", "b.txt", "c.txt"), true);
			foldersInFlight[0].reject(
				new UploadError("Server error: disk full", {
					code: "internal",
					written: ["src/assets/a.txt"],
				}),
			);
			await flush();

			expect(storedSummary(items()[0])).toBe("1 of 3 files were uploaded");

			uploadActions.retryFailed();

			const retry = foldersInFlight[foldersInFlight.length - 1].request;
			expect(retry.merge).toBe(true);
			expect(retry.contents.files.map(({ path }) => path)).toEqual([
				"b.txt",
				"c.txt",
			]);
		});

		it("continues into the folder it created itself rather than tripping over it", async () => {
			const id = sendFolder("assets", contents("a.txt", "b.txt"));
			expect(foldersInFlight[0].request.merge).toBe(false);
			// Removing the half-made folder failed, so the server kept what it had.
			foldersInFlight[0].reject(
				new UploadError("could not be removed", {
					code: "internal",
					written: ["src/assets/a.txt"],
				}),
			);
			await flush();

			uploadActions.retry(id);

			// Claimed afresh, the folder its own first attempt left would be a 409.
			expect(foldersInFlight[1].request.merge).toBe(true);
		});

		it("offers Merge and Keep both when the server finds the name taken", async () => {
			sendFolder("assets", contents("a.txt"));
			foldersInFlight[0].reject(
				new UploadError("src/assets already exists", {
					code: "conflict",
					canRetry: false,
				}),
			);
			await flush();

			expect(items()[0]).toMatchObject({
				status: "failed",
				conflict: "folder",
			});
		});

		it("treats a 409 inside a merge as final", async () => {
			sendFolder("assets", contents("a.txt"), true);
			foldersInFlight[0].reject(
				new UploadError("src/assets/a.txt is a directory", {
					code: "conflict",
					canRetry: false,
				}),
			);
			await flush();

			// No choice on the row gets past an entry in the way.
			expect(items()[0]).toMatchObject({ status: "failed", conflict: "none" });
		});

		it("keeps Keep both when a merge is refused because a file holds the name", async () => {
			sendFolder("assets", contents("a.txt"), true);
			foldersInFlight[0].reject(
				new UploadError(
					"src/assets exists and is not a folder; a merge writes into folders only",
					{ code: "conflict", canRetry: false },
				),
			);
			await flush();

			expect(items()[0]).toMatchObject({ status: "failed", conflict: "file" });
		});

		it("refreshes the listings when a failed upload left files behind", async () => {
			const changed: string[] = [];
			const unsubscribe = onFileUploaded((dir) => changed.push(dir));
			sendFolder("assets", contents("a.txt", "b.txt"), true);
			foldersInFlight[0].reject(
				new UploadError("Server error: disk full", {
					code: "internal",
					written: ["src/assets/a.txt"],
				}),
			);
			await flush();
			unsubscribe();

			expect(changed).toEqual(["src", "src/assets"]);
		});

		it("does not claim nothing was uploaded once the whole body was sent", () => {
			const changed: string[] = [];
			const unsubscribe = onFileUploaded((dir) => changed.push(dir));
			sendFolder("assets", contents("a.txt"));
			foldersInFlight[0].request.onProgress?.(1);

			uploadActions.cancelAll();
			unsubscribe();

			// A body that arrived whole is not cut short: the server may store it.
			expect(storedSummary(items()[0])).toBe(
				"Files already sent may be in assets",
			);
			expect(changed).toEqual(["src", "src/assets"]);
		});

		it("keeps the end of the body even when it rounds like the step before", () => {
			sendFolder("assets", contents("a.txt"));
			foldersInFlight[0].request.onProgress?.(0.996);
			foldersInFlight[0].request.onProgress?.(1);

			uploadActions.cancelAll();

			expect(storedSummary(items()[0])).toBe(
				"Files already sent may be in assets",
			);
		});

		it("cannot say what a merge left when the connection drops", async () => {
			const changed: string[] = [];
			const unsubscribe = onFileUploaded((dir) => changed.push(dir));
			sendFolder("assets", contents("a.txt"), true);
			foldersInFlight[0].reject(new UploadError("Connection lost"));
			await flush();
			unsubscribe();

			expect(storedSummary(items()[0])).toBe(
				"Files already sent may be in assets",
			);
			expect(changed).toEqual(["src", "src/assets"]);
		});

		it("cannot say what a cancelled merge left, and does not pretend to", () => {
			sendFolder("assets", contents("a.txt"), true);
			sendFolder("other", contents("b.txt"));

			uploadActions.cancelAll();

			// Without merge the server removes a folder cut short; with it, what
			// was written stays, and no response arrives to say what.
			expect(storedSummary(items()[0])).toBe(
				"Files already sent may be in assets",
			);
			expect(storedSummary(items()[1])).toBe("Nothing was uploaded");
		});

		it("cannot say what a cancelled resume left either, merge or not asked for", async () => {
			const id = sendFolder("assets", contents("a.txt", "b.txt"));
			foldersInFlight[0].reject(
				new UploadError("could not be removed", {
					code: "internal",
					written: ["src/assets/a.txt"],
				}),
			);
			await flush();
			uploadActions.retry(id);

			uploadActions.cancelAll();

			// The retry merges into what the first attempt left, so whatever it
			// wrote before the cut stays as well.
			expect(storedSummary(items()[0])).toBe(
				"Files already sent may be in assets",
			);
		});

		it("tells the folder's own listing it changed, as well as the destination's", async () => {
			const changed: string[] = [];
			const unsubscribe = onFileUploaded((dir) => changed.push(dir));
			sendFolder("assets", contents("a.txt"));
			foldersInFlight[0].resolve();
			await flush();
			unsubscribe();

			expect(changed).toEqual(["src", "src/assets"]);
			expect(items()[0].status).toBe("done");
		});
	});
});
