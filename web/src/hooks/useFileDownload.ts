import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { isAbortError } from "../lib/api";
import type { TreeOrigin } from "../types/contents";
import { splitPath } from "../utils/path";
import { saveRawFile } from "./useRawMediaSource";

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

/**
 * The download behind a viewer's Download buttons: the file is checked and
 * handed to the browser, which streams it to disk (`saveRawFile`). Running
 * covers only that hand-over — the transfer itself is the browser's to show
 * and to cancel — and is cancelled on a second press and when the file
 * changes.
 */
export function useFileDownload({
	path,
	worktree,
	hash,
	onError,
}: Options): FileDownload {
	const queryClient = useQueryClient();
	const [isDownloading, setIsDownloading] = useState(false);
	const abortRef = useRef<AbortController | null>(null);

	const start = useCallback(async () => {
		const controller = new AbortController();
		abortRef.current = controller;
		setIsDownloading(true);
		onError(null);
		const origin: TreeOrigin = hash
			? { kind: "commit", hash, path }
			: { kind: "file", path };
		try {
			await saveRawFile(
				queryClient,
				origin,
				splitPath(path).fileName,
				controller.signal,
			);
		} catch (err) {
			// A cancellation is the user's own doing and needs no report.
			if (!isAbortError(err)) {
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
	}, [queryClient, path, hash, onError]);

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
	// biome-ignore lint/correctness/useExhaustiveDependencies: the setter is stable; the file's identity is the trigger, not values the body reads
	useEffect(() => {
		setIsDownloading(false);
		return () => abortRef.current?.abort();
	}, [path, worktree, hash]);

	return {
		isDownloading,
		label: isDownloading ? "Cancel download" : "Download",
		toggle,
	};
}
