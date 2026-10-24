import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { isAbortError } from "../lib/api";
import type { TreeOrigin } from "../types/contents";
import { splitPath } from "../utils/path";
import { saveRawFile, saveRawFolder } from "./useRawMediaSource";

interface Options {
	path: string;
	/**
	 * Worktree name; empty for the main one. Part of which file this is, not
	 * where it is read from: a capability serves the connection's worktree.
	 */
	worktree: string;
	/**
	 * The commit to read `path` from, which makes `path` relative to the
	 * repository root. Absent for the file in the work directory.
	 */
	hash?: string;
	/**
	 * Where a failure is reported, and cleared when another attempt starts. A
	 * setter rather than state of the hook's own, so a view can keep one banner
	 * for every action it offers instead of stacking a second error bar.
	 */
	onError: (message: string | null) => void;
}

export interface FileDownload {
	isDownloading: boolean;
	label: string;
	/** Starts a download, or cancels one that has not reached the browser. */
	toggle: () => void;
}

type Download = Omit<FileDownload, "label">;

/**
 * The part of a download the app owns: from the press until `save` has handed
 * it to the browser, which streams it to disk and from then on is the one to
 * show and to cancel it. A second press cancels, as does a change of `target`
 * — whatever names what is being saved — and unmounting.
 */
function useDownload(
	save: (signal: AbortSignal) => Promise<void>,
	target: string,
	onError: (message: string | null) => void,
	onSaved?: () => void,
): Download {
	const [isDownloading, setIsDownloading] = useState(false);
	const abortRef = useRef<AbortController | null>(null);

	const start = useCallback(async () => {
		const controller = new AbortController();
		abortRef.current = controller;
		setIsDownloading(true);
		onError(null);
		let saved = false;
		try {
			await save(controller.signal);
			saved = true;
		} catch (err) {
			// A cancellation is the user's own doing and needs no report — nor
			// does whatever a cancelled download fails with later: a request
			// already in flight, such as the capability's, may reject with an
			// error of its own, to a view that has moved on to something else.
			if (!controller.signal.aborted && !isAbortError(err)) {
				const message = err instanceof Error ? err.message : String(err);
				onError(`Download failed: ${message}`);
			}
		} finally {
			// Only if it is still this download's: a controller belonging to a
			// newer one must stay reachable, or it could never be cancelled, and
			// its spinner must keep turning — an aborted download can settle after
			// the next one has started.
			if (abortRef.current === controller) {
				abortRef.current = null;
				setIsDownloading(false);
			}
		}
		if (saved) onSaved?.();
	}, [save, onError, onSaved]);

	const toggle = useCallback(() => {
		if (isDownloading) {
			abortRef.current?.abort();
			return;
		}
		start();
	}, [isDownloading, start]);

	// A viewer is reused across files, so the spinner must not keep turning
	// for a download that belonged to the previous file, nor that download
	// reach the browser and save the file the user has just navigated away from.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the setter is stable; the target's identity is the trigger, not values the body reads
	useEffect(() => {
		setIsDownloading(false);
		return () => abortRef.current?.abort();
	}, [target]);

	return { isDownloading, toggle };
}

/**
 * The download behind a viewer's Download buttons: the file is checked and
 * handed to the browser, which streams it to disk (`saveRawFile`).
 */
export function useFileDownload({
	path,
	worktree,
	hash,
	onError,
}: Options): FileDownload {
	const queryClient = useQueryClient();
	const save = useCallback(
		(signal: AbortSignal) => {
			const origin: TreeOrigin = hash
				? { kind: "commit", hash, path }
				: { kind: "file", path };
			return saveRawFile(queryClient, origin, splitPath(path).fileName, signal);
		},
		[queryClient, path, hash],
	);
	const download = useDownload(
		save,
		JSON.stringify([path, worktree, hash]),
		onError,
	);
	return {
		...download,
		label: download.isDownloading ? "Cancel download" : "Download",
	};
}

interface FolderOptions {
	/** The folder in the work directory; "" for the work directory itself. */
	path: string;
	/** As `useFileDownload`'s. */
	onError: (message: string | null) => void;
	/** Called once the browser has the archive, and the app is done with it. */
	onSaved: () => void;
}

/**
 * Saves a folder of the work directory as a zip archive (`saveRawFolder`),
 * with the same running state as a file's download. A worktree switch is
 * left to the caller, which unmounts it: nothing here survives one.
 */
export function useFolderDownload({
	path,
	onError,
	onSaved,
}: FolderOptions): FileDownload {
	const save = useCallback(
		(signal: AbortSignal) => saveRawFolder(path, signal),
		[path],
	);
	const download = useDownload(save, path, onError, onSaved);
	return {
		...download,
		label: download.isDownloading ? "Cancel download" : "Download as zip",
	};
}
