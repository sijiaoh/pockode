import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UploadError, type UploadRequest, uploadFile } from "./fileUpload";
import {
	onFileUploaded,
	UPLOAD_CONCURRENCY,
	uploadActions,
	useUploadStore,
} from "./uploadStore";
import { worktreeActions } from "./worktreeStore";

vi.mock("./fileUpload", async (importOriginal) => ({
	...(await importOriginal<typeof import("./fileUpload")>()),
	uploadFile: vi.fn(),
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
		maxUploadSize = 0;
		uploadActions.reset();
		worktreeActions.setCurrent("");
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
				storedCount: 1,
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
});
