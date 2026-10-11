import { useCallback, useEffect, useRef, useState } from "react";
import { isAbortError } from "../lib/api";
import {
	type DownloadRequest,
	downloadFile,
	LARGE_DOWNLOAD_WARNING_SIZE,
} from "../lib/fileDownload";

interface Options extends Omit<DownloadRequest, "signal"> {
	/** The file's size as described, once it is known. */
	size: number | undefined;
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
	/** Starts a download, asks first for a large file, or cancels a running one. */
	toggle: () => void;
	/** The size confirmation is up; see `LargeDownloadDialog`. */
	confirmingSize: boolean;
	confirmSize: () => void;
	cancelSize: () => void;
}

/**
 * The download behind a viewer's Download buttons: one transfer at a time,
 * cancelled on a second press and when the file changes.
 */
export function useFileDownload({
	path,
	worktree,
	hash,
	size,
	onError,
}: Options): FileDownload {
	const [isDownloading, setIsDownloading] = useState(false);
	const [confirmingSize, setConfirmingSize] = useState(false);
	const abortRef = useRef<AbortController | null>(null);

	const start = useCallback(async () => {
		const controller = new AbortController();
		abortRef.current = controller;
		setIsDownloading(true);
		onError(null);
		try {
			await downloadFile({ path, worktree, hash, signal: controller.signal });
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
	}, [path, worktree, hash, onError]);

	const toggle = useCallback(() => {
		if (isDownloading) {
			abortRef.current?.abort();
			return;
		}
		// The whole file is assembled in memory before the browser takes it, so a
		// very large one is worth a word before the tab is on the hook for it.
		if (size !== undefined && size > LARGE_DOWNLOAD_WARNING_SIZE) {
			onError(null);
			setConfirmingSize(true);
			return;
		}
		start();
	}, [isDownloading, size, start, onError]);

	const confirmSize = useCallback(() => {
		setConfirmingSize(false);
		start();
	}, [start]);

	const cancelSize = useCallback(() => setConfirmingSize(false), []);

	// A viewer is reused across files, so a confirmation quoting one file's size
	// must not confirm another's, and the spinner must not keep turning for a
	// transfer that belonged to the previous file.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the setters are stable; the file's identity is the trigger, not values the body reads
	useEffect(() => {
		setConfirmingSize(false);
		setIsDownloading(false);
		// Nor should a transfer keep running for a page nobody is looking at, or
		// save the file the user has just navigated away from.
		return () => abortRef.current?.abort();
	}, [path, worktree, hash]);

	return {
		isDownloading,
		label: isDownloading ? "Cancel download" : "Download",
		toggle,
		confirmingSize,
		confirmSize,
		cancelSize,
	};
}
