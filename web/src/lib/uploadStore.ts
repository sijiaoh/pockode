import { useMemo } from "react";
import { create } from "zustand";
import { formatBytes } from "../utils/bytes";
import { isAbortError } from "./api";
import { type NameCollision, UploadError, uploadFile } from "./fileUpload";
import { useWorktreeStore, worktreeActions } from "./worktreeStore";
import { useWSStore } from "./wsStore";

/**
 * Files uploading at the same time.
 *
 * A browser allows six connections per origin, and the tree, the search and
 * every file read compete for them, so uploads must not take the pool. Over a
 * relay the number buys nothing anyway: every request shares one tunnel and is
 * buffered whole before it is forwarded, so parallelism there multiplies the
 * memory in flight without adding throughput. Three overlaps the round trips —
 * the part that is worth overlapping — and leaves the rest of the app moving.
 */
export const UPLOAD_CONCURRENCY = 3;

/** Files accepted in one go; more than this is a mistaken selection. */
export const MAX_FILES_PER_UPLOAD = 50;

/** How long a queue that fully succeeded stays on screen before clearing. */
const AUTO_DISMISS_MS = 3000;

const FOLDER_IN_THE_WAY = "A folder with this name exists";
const WORKTREE_CHANGED = "Cancelled — worktree changed";

export type UploadStatus =
	| "queued"
	| "uploading"
	| "done"
	| "failed"
	| "cancelled";

export interface UploadItem {
	id: string;
	file: File;
	/** Name it is stored under; differs from `file.name` after "Keep both". */
	name: string;
	/** Destination directory; empty is the workspace root. */
	destPath: string;
	/** Fixed when the upload is queued, so a worktree switch cannot move it. */
	worktree: string;
	overwrite: boolean;
	status: UploadStatus;
	/** Fraction of the body sent, 0 to 1. */
	progress: number;
	error: string | null;
	/** Whether a plain retry is worth offering; read only while `failed`. */
	canRetry: boolean;
	/** Which resolutions a name collision leaves open, if it is one. */
	conflict: NameCollision;
}

export interface NewUpload {
	file: File;
	/** Stored name; defaults to the file's own. */
	name?: string;
	destPath: string;
	overwrite?: boolean;
	/**
	 * A collision found in the destination listing with something the endpoint
	 * will not replace. Such an upload is never sent: it joins the queue already
	 * failed, offering the one resolution that is safe.
	 */
	blockedBy?: "folder";
}

interface UploadState {
	items: UploadItem[];
}

export const useUploadStore = create<UploadState>(() => ({ items: [] }));

// Not reactive: an AbortController per running request, and one auto-dismiss
// timer per worktree.
const controllers = new Map<string, AbortController>();
const autoDismissTimers = new Map<string, number>();
let lastId = 0;

type UploadedListener = (destPath: string, worktree: string) => void;
const uploadedListeners = new Set<UploadedListener>();

/**
 * Called once per stored file, so a view of that directory can refresh.
 *
 * The store cannot invalidate queries itself: the query client is created per
 * app rather than exported, and reaching for one here would tie the queue to
 * react-query for a single call.
 */
export function onFileUploaded(listener: UploadedListener): () => void {
	uploadedListeners.add(listener);
	return () => {
		uploadedListeners.delete(listener);
	};
}

function patchItem(id: string, patch: Partial<UploadItem>): void {
	useUploadStore.setState((state) => ({
		items: state.items.map((item) =>
			item.id === id ? { ...item, ...patch } : item,
		),
	}));
}

function itemById(id: string): UploadItem | undefined {
	return useUploadStore.getState().items.find((item) => item.id === id);
}

function clearAutoDismiss(worktree: string): void {
	const timer = autoDismissTimers.get(worktree);
	if (timer === undefined) return;
	clearTimeout(timer);
	autoDismissTimers.delete(worktree);
}

/**
 * Clears a queue that has nothing left to say.
 *
 * Only when every entry succeeded: a failure has to stay until it is read, and
 * a cancellation is the one piece of feedback that a worktree switch dropped
 * the uploads that were running.
 */
function scheduleAutoDismiss(worktree: string): void {
	clearAutoDismiss(worktree);
	const items = useUploadStore
		.getState()
		.items.filter((item) => item.worktree === worktree);
	if (items.length === 0) return;
	if (!items.every((item) => item.status === "done")) return;

	const ids = new Set(items.map((item) => item.id));
	autoDismissTimers.set(
		worktree,
		window.setTimeout(() => {
			autoDismissTimers.delete(worktree);
			useUploadStore.setState((state) => ({
				items: state.items.filter((item) => !ids.has(item.id)),
			}));
		}, AUTO_DISMISS_MS),
	);
}

function settle(id: string, patch: Partial<UploadItem>): void {
	const item = itemById(id);
	// A cancellation is already this upload's outcome; a late response must not
	// overwrite it with one the user did not ask for.
	if (!item || item.status === "cancelled") return;
	patchItem(id, patch);
	if (patch.status === "done") {
		for (const listener of uploadedListeners) {
			listener(item.destPath, item.worktree);
		}
	}
	scheduleAutoDismiss(item.worktree);
}

/**
 * Records progress only when it becomes visible.
 *
 * The queue shows whole percentages, and every store write re-renders the Files
 * tab; a large file over a slow link reports thousands of times, which would be
 * thousands of renders of the file tree for something nobody can see.
 */
function reportProgress(id: string, fraction: number): void {
	const item = itemById(id);
	if (!item || item.status !== "uploading") return;
	if (Math.round(item.progress * 100) === Math.round(fraction * 100)) return;
	patchItem(id, { progress: fraction });
}

function start(item: UploadItem): void {
	const controller = new AbortController();
	controllers.set(item.id, controller);
	patchItem(item.id, {
		status: "uploading",
		progress: 0,
		error: null,
		conflict: "none",
	});

	uploadFile({
		file: item.file,
		name: item.name,
		destPath: item.destPath,
		worktree: item.worktree,
		overwrite: item.overwrite,
		signal: controller.signal,
		onProgress: (fraction) => reportProgress(item.id, fraction),
	})
		// Two handlers rather than `.then().catch()`: a `.catch` would also see
		// anything the success path throws — a listener refreshing the directory,
		// say — and report the upload that just succeeded as a failure.
		.then(
			() => settle(item.id, { status: "done", progress: 1 }),
			(error: unknown) => {
				// The cancellation already recorded the outcome.
				if (isAbortError(error)) return;

				// One file per request, so a `written` entry can only be this file:
				// the request failed after it had been stored in full, and calling
				// that a failure would ask the user to send it a second time.
				if (error instanceof UploadError && error.storedCount > 0) {
					settle(item.id, { status: "done", progress: 1 });
					return;
				}

				const failure =
					error instanceof UploadError
						? {
								message: error.message,
								canRetry: error.canRetry,
								code: error.code,
							}
						: {
								message: error instanceof Error ? error.message : String(error),
								canRetry: true,
								code: "",
							};
				settle(item.id, {
					status: "failed",
					error: failure.message,
					canRetry: failure.canRetry,
					// The endpoint answers `409` for a folder of that name exactly as
					// it does for a file, so this offers both resolutions and lets the
					// server refuse a replacement it was never going to make.
					conflict: failure.code === "conflict" ? "file" : "none",
				});
			},
		)
		.finally(() => {
			controllers.delete(item.id);
			pump();
		});
}

/**
 * Refuses what this connection cannot carry, before anything is sent.
 *
 * On a relay an oversized request never arrives as a request: the tunnel's read
 * limit is overrun and it drops, taking every other stream with it, so there is
 * no `413` to fall back on. `max_upload_size` describes the route this
 * connection came in on and is re-read here rather than remembered, because a
 * reconnect can land on a different one (see docs/file.md#transfer).
 */
function rejectOversized(): void {
	const limit = useWSStore.getState().maxUploadSize;
	if (limit <= 0) return;

	const message = `Too large (max ${formatBytes(limit)})`;
	useUploadStore.setState((state) => ({
		items: state.items.map((item) =>
			item.status === "queued" && item.file.size > limit
				? { ...item, status: "failed", error: message, canRetry: false }
				: item,
		),
	}));
}

function pump(): void {
	rejectOversized();

	const { items } = useUploadStore.getState();
	let slots =
		UPLOAD_CONCURRENCY -
		items.filter((item) => item.status === "uploading").length;
	for (const item of items) {
		if (slots <= 0) break;
		if (item.status !== "queued") continue;
		start(item);
		slots -= 1;
	}
}

function cancelUnfinished(matches: (item: UploadItem) => boolean, why: string) {
	for (const item of useUploadStore.getState().items) {
		if (item.status !== "queued" && item.status !== "uploading") continue;
		if (!matches(item)) continue;
		controllers.get(item.id)?.abort();
		patchItem(item.id, { status: "cancelled", error: why, progress: 0 });
	}
	pump();
}

export const uploadActions = {
	enqueue: (uploads: NewUpload[]) => {
		if (uploads.length === 0) return;
		const worktree = worktreeActions.getCurrent();
		clearAutoDismiss(worktree);

		const items = uploads.map<UploadItem>((upload) => {
			lastId += 1;
			const blocked = upload.blockedBy === "folder";
			return {
				id: String(lastId),
				file: upload.file,
				name: upload.name ?? upload.file.name,
				destPath: upload.destPath,
				worktree,
				overwrite: upload.overwrite ?? false,
				status: blocked ? "failed" : "queued",
				progress: 0,
				error: blocked ? FOLDER_IN_THE_WAY : null,
				canRetry: false,
				conflict: blocked ? "folder" : "none",
			};
		});

		useUploadStore.setState((state) => ({ items: [...state.items, ...items] }));
		pump();
	},

	/** Sends a failed upload again, optionally under a new name or as a replacement. */
	retry: (id: string, changes: { name?: string; overwrite?: boolean } = {}) => {
		const item = itemById(id);
		if (!item) return;
		clearAutoDismiss(item.worktree);
		patchItem(id, {
			...changes,
			status: "queued",
			progress: 0,
			error: null,
			canRetry: true,
			conflict: "none",
		});
		pump();
	},

	retryFailed: () => {
		const worktree = worktreeActions.getCurrent();
		for (const item of useUploadStore.getState().items) {
			if (item.worktree !== worktree) continue;
			if (item.status !== "failed" || !item.canRetry) continue;
			uploadActions.retry(item.id);
		}
	},

	cancelAll: () => {
		const worktree = worktreeActions.getCurrent();
		cancelUnfinished((item) => item.worktree === worktree, "Cancelled");
	},

	/** Drops the finished entries of the current worktree from the queue. */
	dismiss: () => {
		const worktree = worktreeActions.getCurrent();
		clearAutoDismiss(worktree);
		useUploadStore.setState((state) => ({
			items: state.items.filter(
				(item) =>
					item.worktree !== worktree ||
					item.status === "queued" ||
					item.status === "uploading",
			),
		}));
	},

	reset: () => {
		for (const controller of controllers.values()) controller.abort();
		controllers.clear();
		for (const timer of autoDismissTimers.values()) clearTimeout(timer);
		autoDismissTimers.clear();
		useUploadStore.setState({ items: [] });
	},
};

// An upload's worktree is decided when it is queued and travels in the request,
// so one still running after a switch would write into a tree the user has
// already left — a file split across two of them is worse than a failed upload.
worktreeActions.onWorktreeChange((_prev, next) => {
	cancelUnfinished((item) => item.worktree !== next, WORKTREE_CHANGED);
});

/** Queue entries belonging to the worktree currently on screen. */
export function useWorktreeUploads(): UploadItem[] {
	const items = useUploadStore((state) => state.items);
	const worktree = useWorktreeStore((state) => state.current);
	return useMemo(
		() => items.filter((item) => item.worktree === worktree),
		[items, worktree],
	);
}

/** Whether the current worktree has any queue entry whose status `matches`. */
function useAnyUpload(matches: (status: UploadStatus) => boolean): boolean {
	const items = useUploadStore((state) => state.items);
	const worktree = useWorktreeStore((state) => state.current);
	return items.some(
		(item) => item.worktree === worktree && matches(item.status),
	);
}

/**
 * Whether the Files tab has upload news, for its sidebar badge.
 *
 * The queue is only visible on that tab, so anything unfinished or failed would
 * otherwise go unnoticed from anywhere else in the app.
 */
export function useHasUploadActivity(): boolean {
	return useAnyUpload(
		(status) =>
			status === "queued" || status === "uploading" || status === "failed",
	);
}

/**
 * Whether an upload still has something to report to the queue on screen.
 *
 * Narrower than the badge on purpose. A failed row has already said everything
 * it has to say and then stays until it is dismissed, so counting it here would
 * be a state with no natural end — one failure nobody cleared, and every file
 * tapped from then on would leave the drawer standing open.
 */
export function useHasUnfinishedUploads(): boolean {
	return useAnyUpload(
		(status) => status === "queued" || status === "uploading",
	);
}
