import { useMemo } from "react";
import { create } from "zustand";
import { formatBytes } from "../utils/bytes";
import { isAbortError } from "./api";
import {
	type FolderContents,
	type NameCollision,
	UploadError,
	uploadFile,
	uploadFolder,
} from "./fileUpload";
import { folderCountRefusal } from "./folderRead";
import { useWorktreeStore, worktreeActions } from "./worktreeStore";
import { useWSStore } from "./wsStore";

/**
 * Requests uploading at the same time: one per file, one per folder.
 *
 * A browser allows six connections per origin, and the tree, the search and
 * every file read compete for them, so uploads must not take the pool. Three
 * overlaps the round trips — the part that is worth overlapping — and leaves
 * the rest of the app moving. The relay does not change the number: it carries
 * each request on its own yamux stream and forwards the body as it arrives, so
 * concurrent uploads behave there as they do locally.
 */
export const UPLOAD_CONCURRENCY = 3;

/** Files accepted in one go; more than this is a mistaken selection. */
export const MAX_FILES_PER_UPLOAD = 50;

/** How long a queue that fully succeeded stays on screen before clearing. */
const AUTO_DISMISS_MS = 3000;

const FOLDER_IN_THE_WAY = "A folder with this name exists";
const FILE_IN_THE_WAY = "A file with this name exists";
const WORKTREE_CHANGED = "Cancelled — worktree changed";

/**
 * `reading` and `held` belong to a folder alone: it is being walked, then it is
 * waiting for the conflict dialog to be answered. Both count as unfinished — the
 * folder is on its way, and leaving the page would lose it.
 */
export type UploadStatus =
	| "reading"
	| "held"
	| "queued"
	| "uploading"
	| "done"
	| "failed"
	| "cancelled";

/** What a queue entry holds when it is a folder rather than a file. */
export interface FolderUpload {
	contents: FolderContents;
	/** Files found so far, while `reading`. */
	readCount: number;
	/**
	 * Paths, relative to the folder, of the files the server has confirmed
	 * stored. They stay on disk whatever happens to the rest, so a failed or
	 * cancelled row says how many there are, and a retry never sends them again.
	 */
	stored: string[];
	/**
	 * Set when the upload stopped where the server may have kept files and
	 * nothing came back to say which (mayHoldUnreported).
	 */
	storedUnknown: boolean;
}

export interface UploadItem {
	id: string;
	/** Null for a folder. */
	file: File | null;
	/** Null for a file. */
	folder: FolderUpload | null;
	/** Bytes the entry weighs in progress: the file, or every file of the folder. */
	size: number;
	/** Name it is stored under; differs from the original after "Keep both". */
	name: string;
	/** Destination directory; empty is the workspace root. */
	destPath: string;
	/** Fixed when the upload is queued, so a worktree switch cannot move it. */
	worktree: string;
	/**
	 * Write over what is there: replace, for a file; merge into the existing
	 * folder, for a folder. One field because it is one decision — the dialog's
	 * middle button — and one inline action on a row that failed on a `409`.
	 */
	overwrite: boolean;
	status: UploadStatus;
	/** Fraction of the body sent, 0 to 1. */
	progress: number;
	error: string | null;
	/** Whether a plain retry is worth offering; read only while `failed`. */
	canRetry: boolean;
	/**
	 * What the name collided with, if that is why it failed. Writing over it is
	 * offered only where it is the same kind of thing — a file over a file, a
	 * folder into a folder — and Keep both always.
	 */
	conflict: NameCollision;
}

/** Whether a failed entry can be resolved by writing over what is in its way. */
export function canOverwrite(item: UploadItem): boolean {
	return item.conflict === (item.folder ? "folder" : "file");
}

/** Files of a folder entry the server has not confirmed stored. */
function unsentFiles(folder: FolderUpload): FolderContents["files"] {
	if (folder.stored.length === 0) return folder.contents.files;
	const stored = new Set(folder.stored);
	return folder.contents.files.filter(({ path }) => !stored.has(path));
}

/**
 * Whether a folder entry is sent with `merge=true`: when that was the answer,
 * and whenever the folder already holds files of this upload — claimed afresh,
 * it would be refused as a conflict with itself.
 */
function isMerge(item: UploadItem): boolean {
	return item.overwrite || (item.folder?.stored.length ?? 0) > 0;
}

function filesBytes(files: FolderContents["files"]): number {
	return files.reduce((sum, { file }) => sum + file.size, 0);
}

/**
 * What a folder row that stopped short says about what it left on disk. Never
 * empty: that count is what keeps a partial upload from being silent.
 */
export function storedSummary(item: UploadItem): string {
	const { folder } = item;
	if (!folder) return "";
	if (folder.storedUnknown) {
		return `Files already sent may be in ${item.name}`;
	}
	const total = folder.contents.files.length;
	const stored = folder.stored.length;
	if (stored === 0) return "Nothing was uploaded";
	return `${stored} of ${total} files were uploaded`;
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

/** Where a folder that has just arrived is to go, before it has been read. */
export interface NewFolder {
	name: string;
	destPath: string;
}

interface UploadState {
	items: UploadItem[];
}

export const useUploadStore = create<UploadState>(() => ({ items: [] }));

const READ_COUNT_STEP = 25;

// Not reactive: an AbortController per running request, and one auto-dismiss
// timer per worktree.
const controllers = new Map<string, AbortController>();
const autoDismissTimers = new Map<string, number>();
let lastId = 0;

type UploadedListener = (destPath: string, worktree: string) => void;
const uploadedListeners = new Set<UploadedListener>();

/**
 * Called for each directory an upload changed — a file's destination, or a
 * folder's destination and the folder itself — so a view of it can refresh.
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
	if (patch.status === "done") notifyChanged(item);
	scheduleAutoDismiss(item.worktree);
}

function notifyChanged(item: UploadItem): void {
	// A folder merged into one that is already listed has new entries of its
	// own listing too, not only the destination's.
	const changed = item.folder
		? [item.destPath, joinPath(item.destPath, item.name)]
		: [item.destPath];
	for (const dir of changed) {
		for (const listener of uploadedListeners) listener(dir, item.worktree);
	}
}

/**
 * Whether a folder upload that stopped without the server saying what it
 * stored may still have left files: a merge keeps what it wrote, and a body
 * sent in full is not cut short, so the server may be storing all of it.
 * Without merge, a body cut short is removed whole.
 */
function mayHoldUnreported(item: UploadItem): boolean {
	return isMerge(item) || item.progress >= 1;
}

/**
 * Whether a folder entry that did not finish may have left files on disk: a
 * merge keeps what it wrote, and a new folder stays when the server could not
 * remove it (`written` then lists its files).
 */
function mayHaveLeftFiles(folder: FolderUpload | undefined): boolean {
	return !!folder && (folder.stored.length > 0 || folder.storedUnknown);
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
	// The end is always kept, whatever it rounds to: a body sent in full is
	// what tells a folder the server may have stored it (mayHoldUnreported).
	if (
		fraction < 1 &&
		Math.round(item.progress * 100) === Math.round(fraction * 100)
	)
		return;
	patchItem(id, { progress: fraction });
}

function joinPath(dir: string, name: string): string {
	return dir ? `${dir}/${name}` : name;
}

function failureOf(error: unknown): {
	message: string;
	canRetry: boolean;
	code: string;
} {
	return error instanceof UploadError
		? { message: error.message, canRetry: error.canRetry, code: error.code }
		: {
				message: error instanceof Error ? error.message : String(error),
				canRetry: true,
				code: "",
			};
}

function startFolder(item: UploadItem, folder: FolderUpload): void {
	const controller = new AbortController();
	controllers.set(item.id, controller);
	patchItem(item.id, {
		status: "uploading",
		progress: 0,
		error: null,
		conflict: "none",
	});

	const merge = isMerge(item);
	const files = unsentFiles(folder);
	// Weighed by what this request carries: a retry's stored files are not in
	// it, and counting them would hold the bar short of the end for good.
	patchItem(item.id, { size: filesBytes(files) });
	uploadFolder({
		name: item.name,
		destPath: item.destPath,
		worktree: item.worktree,
		contents: { files, dirs: folder.contents.dirs },
		merge,
		signal: controller.signal,
		onProgress: (fraction) => reportProgress(item.id, fraction),
	})
		.then(
			() =>
				settle(item.id, {
					status: "done",
					progress: 1,
					folder: {
						...folder,
						stored: folder.contents.files.map(({ path }) => path),
					},
				}),
			(error: unknown) => {
				if (isAbortError(error)) return;
				const failure = failureOf(error);
				const folderPath = joinPath(item.destPath, item.name);
				const prefix = `${folderPath}/`;
				const written =
					error instanceof UploadError
						? error.written
								.filter((path) => path.startsWith(prefix))
								.map((path) => path.slice(prefix.length))
						: [];
				// No `{error, code}` body — the connection dropped, or something
				// between answered — is the same unknown a cancellation leaves.
				const current = itemById(item.id);
				const unreported =
					failure.code === "" &&
					written.length === 0 &&
					!!current &&
					mayHoldUnreported(current);
				const failed = {
					...folder,
					stored: [...new Set([...folder.stored, ...written])],
					storedUnknown: folder.storedUnknown || unreported,
				};
				settle(item.id, {
					status: "failed",
					error: failure.message,
					canRetry: failure.canRetry,
					conflict: folderConflict(failure, merge, folderPath),
					folder: failed,
				});
				if (mayHaveLeftFiles(failed)) notifyChanged(item);
			},
		)
		.finally(() => {
			controllers.delete(item.id);
			pump();
		});
}

/**
 * Which resolutions a folder's failure leaves open.
 *
 * Without merge a `409` can only be about the folder's own name. With merge it
 * is about an entry inside, which no choice on this row can get past — unless
 * the server names the folder itself, which a file holds: merging into that is
 * refused, and Keep both still works. The server's messages start with the path
 * at fault, so the folder's path and a space can only be the folder itself.
 */
function folderConflict(
	failure: { code: string; message: string },
	merge: boolean,
	folderPath: string,
): NameCollision {
	if (failure.code !== "conflict") return "none";
	if (!merge) return "folder";
	return failure.message.startsWith(`${folderPath} `) ? "file" : "none";
}

function start(item: UploadItem): void {
	if (item.folder) {
		startFolder(item, item.folder);
		return;
	}
	const file = item.file;
	if (!file) return;
	const controller = new AbortController();
	controllers.set(item.id, controller);
	patchItem(item.id, {
		status: "uploading",
		progress: 0,
		error: null,
		conflict: "none",
	});

	uploadFile({
		file,
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

				const failure = failureOf(error);
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
 * The limit is the request's, and a folder is one request, so it is the
 * folder's total that has to fit (docs/file.md#uploading-a-folder).
 */
function folderSizeRefusal(
	name: string,
	files: FolderContents["files"],
): string | null {
	const limit = useWSStore.getState().maxUploadSize;
	if (limit <= 0) return null;
	const bytes = filesBytes(files);
	return bytes > limit
		? `${name} is ${formatBytes(bytes)} (max ${formatBytes(limit)})`
		: null;
}

/**
 * Refuses what the server would refuse, before spending a slow link on it.
 *
 * `max_upload_size` is read from the store rather than hard-coded, so the
 * endpoint stays free to change what it accepts (see docs/file.md#transfer).
 */
function rejectOversized(): void {
	const limit = useWSStore.getState().maxUploadSize;
	if (limit <= 0) return;

	const refusal = (item: UploadItem): string | null => {
		if (item.folder)
			return folderSizeRefusal(item.name, unsentFiles(item.folder));
		return item.size > limit ? `Too large (max ${formatBytes(limit)})` : null;
	};
	useUploadStore.setState((state) => ({
		items: state.items.map((item) => {
			if (item.status !== "queued") return item;
			const message = refusal(item);
			return message
				? { ...item, status: "failed", error: message, canRetry: false }
				: item;
		}),
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

export function isUnfinished(status: UploadStatus): boolean {
	return (
		status === "reading" ||
		status === "held" ||
		status === "queued" ||
		status === "uploading"
	);
}

function cancelUnfinished(matches: (item: UploadItem) => boolean, why: string) {
	for (const item of useUploadStore.getState().items) {
		if (!isUnfinished(item.status)) continue;
		if (!matches(item)) continue;
		controllers.get(item.id)?.abort();
		controllers.delete(item.id);
		const folder =
			item.folder && item.status === "uploading" && mayHoldUnreported(item)
				? { ...item.folder, storedUnknown: true }
				: item.folder;
		patchItem(item.id, {
			status: "cancelled",
			error: why,
			progress: 0,
			folder,
		});
		if (folder?.storedUnknown) notifyChanged(item);
	}
	pump();
}

function newItem(
	fields: Pick<UploadItem, "file" | "folder" | "size" | "name" | "destPath">,
	worktree: string,
): UploadItem {
	lastId += 1;
	return {
		id: String(lastId),
		...fields,
		worktree,
		overwrite: false,
		status: "queued",
		progress: 0,
		error: null,
		canRetry: false,
		conflict: "none",
	};
}

function folderItem(
	id: string,
): (UploadItem & { folder: FolderUpload }) | null {
	const item = itemById(id);
	return item?.folder ? { ...item, folder: item.folder } : null;
}

export const uploadActions = {
	enqueue: (uploads: NewUpload[]) => {
		if (uploads.length === 0) return;
		const worktree = worktreeActions.getCurrent();
		clearAutoDismiss(worktree);

		const items = uploads.map<UploadItem>((upload) => {
			const blocked = upload.blockedBy === "folder";
			return {
				...newItem(
					{
						file: upload.file,
						folder: null,
						size: upload.file.size,
						name: upload.name ?? upload.file.name,
						destPath: upload.destPath,
					},
					worktree,
				),
				overwrite: upload.overwrite ?? false,
				status: blocked ? "failed" : "queued",
				error: blocked ? FOLDER_IN_THE_WAY : null,
				conflict: blocked ? "folder" : "none",
			};
		});

		useUploadStore.setState((state) => ({ items: [...state.items, ...items] }));
		pump();
	},

	/**
	 * Puts folders in the queue the moment they arrive, before they are read:
	 * walking a large one takes seconds, and that wait has to be on screen and
	 * cancellable like any other. Each gets the signal its walk should stop on.
	 */
	addFolders: (folders: NewFolder[]): { id: string; signal: AbortSignal }[] => {
		const worktree = worktreeActions.getCurrent();
		clearAutoDismiss(worktree);
		const added = folders.map((folder) => {
			const item: UploadItem = {
				...newItem(
					{
						file: null,
						folder: {
							contents: { files: [], dirs: [] },
							readCount: 0,
							stored: [],
							storedUnknown: false,
						},
						size: 0,
						name: folder.name,
						destPath: folder.destPath,
					},
					worktree,
				),
				status: "reading",
			};
			const controller = new AbortController();
			controllers.set(item.id, controller);
			return { item, signal: controller.signal };
		});
		useUploadStore.setState((state) => ({
			items: [...state.items, ...added.map(({ item }) => item)],
		}));
		return added.map(({ item, signal }) => ({ id: item.id, signal }));
	},

	/** Records how many files the walk has found, for the reading row. */
	readProgress: (id: string, readCount: number) => {
		// Every store write re-renders the Files tab, and a walk reports once per
		// file; a count that moves in steps reads just as well (reportProgress).
		if (readCount % READ_COUNT_STEP !== 0) return;
		const item = folderItem(id);
		if (!item || item.status !== "reading") return;
		patchItem(id, { folder: { ...item.folder, readCount } });
	},

	/**
	 * A folder read in full, now waiting for the conflict dialog — or failed
	 * right here, if it is more than one upload takes, so that nobody is asked
	 * what to do about a name for a folder that would be refused anyway.
	 *
	 * Only from `reading`: one cancelled meanwhile stays cancelled. Answers
	 * whether the folder is now held.
	 */
	holdFolder: (id: string, contents: FolderContents): boolean => {
		const item = folderItem(id);
		if (!item || item.status !== "reading") return false;
		controllers.delete(id);
		patchItem(id, {
			status: "held",
			size: filesBytes(contents.files),
			folder: { ...item.folder, contents, readCount: contents.files.length },
		});
		const refusal =
			folderCountRefusal(item.name, contents)?.message ??
			folderSizeRefusal(item.name, contents.files);
		if (refusal) {
			uploadActions.failFolder(id, refusal);
			return false;
		}
		return true;
	},

	/**
	 * Refuses a folder that has not been sent: it could not be read, it is too
	 * large, or a file holds its name (`blockedBy`, offered Keep both only).
	 */
	failFolder: (id: string, message: string, blockedBy?: "file") => {
		const item = itemById(id);
		if (!item || (item.status !== "reading" && item.status !== "held")) return;
		controllers.delete(id);
		patchItem(id, {
			status: "failed",
			error: blockedBy ? FILE_IN_THE_WAY : message,
			canRetry: false,
			conflict: blockedBy ?? "none",
		});
		scheduleAutoDismiss(item.worktree);
	},

	/** Sends a held folder, under a new name or merged when that was the answer. */
	queueFolder: (
		id: string,
		changes: { name?: string; overwrite?: boolean } = {},
	) => {
		const item = itemById(id);
		if (!item || item.status !== "held") return;
		patchItem(id, { ...changes, status: "queued" });
		pump();
	},

	/** Takes a folder the user chose to skip out of the queue: skipping is not a failure. */
	dropFolder: (id: string) => {
		const item = itemById(id);
		if (!item || !isUnfinished(item.status)) return;
		controllers.get(id)?.abort();
		controllers.delete(id);
		useUploadStore.setState((state) => ({
			items: state.items.filter((entry) => entry.id !== id),
		}));
		scheduleAutoDismiss(item.worktree);
	},

	/** Sends a failed upload again, optionally under a new name or as a replacement. */
	retry: (id: string, changes: { name?: string; overwrite?: boolean } = {}) => {
		const item = itemById(id);
		if (!item) return;
		clearAutoDismiss(item.worktree);
		// A new name is a new folder: nothing of this upload is in it yet.
		const folder =
			item.folder && changes.name !== undefined
				? { ...item.folder, stored: [], storedUnknown: false }
				: item.folder;
		patchItem(id, {
			...changes,
			folder,
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
				(item) => item.worktree !== worktree || isUnfinished(item.status),
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
	return useAnyUpload((status) => isUnfinished(status) || status === "failed");
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
	return useAnyUpload(isUnfinished);
}
