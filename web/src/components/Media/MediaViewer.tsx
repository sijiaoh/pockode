import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Download, ExternalLink, Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useBackToClose } from "../../hooks/useBackToClose";
import { imageSourceBlob } from "../../hooks/useImageSrc";
import { saveRawFile } from "../../hooks/useRawMediaSource";
import { saveBlob } from "../../lib/fileDownload";
import { saveCheckedUrl } from "../../lib/rawProbe";
import { errorMessage } from "../../utils/errorMessage";
import {
	formatExternalImageCaption,
	formatMediaCaption,
} from "../../utils/fileView";
import { FileStateCard, headerButtonClass, Sheet, Spinner } from "../ui";
import PageNotice from "./PageNotice";
import { loadedStage, loadStage } from "./stages";
import type {
	MediaItem,
	MediaKind,
	MediaMetadata,
	StageComponent,
	StageKeyHandler,
} from "./types";

export interface MediaViewerProps {
	item: MediaItem;
	/**
	 * Opens the item's work-directory file in Files. Absent when the item is not
	 * one or the host cannot navigate; the viewer then offers no way over.
	 */
	openInFiles?: () => void;
	onClose: () => void;
	/**
	 * Runs once the viewer has closed — by any of the viewer's own ways — and
	 * its history entry is gone, for an opener that must not change the history
	 * under it before then: a navigation it makes then would be undone, or
	 * stepped over, by the Back that takes the entry.
	 */
	afterClose?: () => void;
}

type StageState =
	| { status: "loading" }
	| { status: "loaded"; Stage: StageComponent }
	| { status: "failed"; error: unknown };

/**
 * The stage for `kind`, loaded on first use. `import()` held in state rather
 * than `React.lazy`: the app has no error boundary, and a rejected lazy import
 * — offline, or a relay link dropped mid-load — would take the whole tree down
 * instead of offering a retry.
 */
function useStage(kind: MediaKind) {
	const [state, setState] = useState<StageState>(() => {
		const Stage = loadedStage(kind);
		return Stage ? { status: "loaded", Stage } : { status: "loading" };
	});
	const [attempt, setAttempt] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is what a retry changes
	useEffect(() => {
		const ready = loadedStage(kind);
		if (ready) {
			setState((current) =>
				current.status === "loaded" && current.Stage === ready
					? current
					: { status: "loaded", Stage: ready },
			);
			return;
		}
		let cancelled = false;
		setState({ status: "loading" });
		loadStage(kind).then(
			(Stage) => {
				if (!cancelled) setState({ status: "loaded", Stage });
			},
			(error: unknown) => {
				if (!cancelled) setState({ status: "failed", error });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [kind, attempt]);

	return { state, retry: () => setAttempt((n) => n + 1) };
}

function caption(item: MediaItem, loaded: MediaMetadata | null): string {
	const dimensions = loaded
		? loaded.dimensions
		: item.kind === "html"
			? undefined
			: item.dimensions;
	if (item.kind === "image" && item.source.kind === "external") {
		return formatExternalImageCaption(item.source.url, dimensions);
	}
	return formatMediaCaption(item.mime, item.size, {
		dimensions,
		duration: loaded
			? loaded.duration
			: item.kind === "video"
				? item.duration
				: undefined,
	});
}

/**
 * Saves the item under `saveAs`. An image's bytes are read whole — usually a
 * cache hit on what the `<img>` already read. A video goes to disk straight
 * from its capability as it arrives (`saveRawFile`): a long recording does
 * not belong in a Blob. A page is saved from the URL its stage loaded it
 * from, under the root capability it already holds, rather than a second
 * capability for the file alone; only the `.html`, not its assets.
 */
async function saveItem(
	queryClient: ReturnType<typeof useQueryClient>,
	item: MediaItem,
	stageUrl: string | null,
): Promise<void> {
	switch (item.kind) {
		case "image":
			saveBlob(await imageSourceBlob(queryClient, item.source), item.saveAs);
			return;
		case "video":
			await saveRawFile(queryClient, item.origin, item.saveAs);
			return;
		case "html":
			if (!stageUrl) throw new Error("the page has not loaded");
			await saveCheckedUrl(stageUrl, item.saveAs);
			return;
	}
}

/**
 * A piece of media on a screen of its own (docs/media-viewer.md): the chrome
 * every kind shares — title and caption, Save, Open in Files, the back
 * gesture, the frame that holds focus — around the stage for the item's kind.
 *
 * Built on `Sheet fullScreen`, which brings the scroll lock, the Escape claim,
 * the focus trap and closing when covered. Never open one from inside another
 * sheet: both listen for Escape on `document`, and one press would close both.
 */
export function MediaViewer({
	item,
	openInFiles,
	onClose,
	afterClose,
}: MediaViewerProps) {
	const queryClient = useQueryClient();
	/** Run once the viewer's history entry is gone; see `useBackToClose`. */
	const afterCloseRef = useRef<(() => void) | null>(null);
	// Set as the viewer closes rather than ahead of time: `useBackToClose` runs
	// and clears it at any unmount, StrictMode's rehearsal included.
	const closeThen = (then?: () => void) => {
		afterCloseRef.current =
			afterClose || then
				? () => {
						afterClose?.();
						then?.();
					}
				: null;
		onClose();
	};
	// What the sheet gets: its backdrop passes the click on as an argument.
	const close = () => closeThen();
	useBackToClose(close, afterCloseRef);

	const frameRef = useRef<HTMLElement>(null);
	const keysRef = useRef<StageKeyHandler | null>(null);
	const saveUrlRef = useRef<string | null>(null);
	const [toolbarStart, setToolbarStart] = useState<HTMLElement | null>(null);
	const [loaded, setLoaded] = useState<MediaMetadata | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	// A save waits on the server before the browser takes it — a capability,
	// the byte it checks first — and a second press meanwhile would save twice.
	const savingRef = useRef(false);
	const { state: stage, retry } = useStage(item.kind);
	// An external image's bytes are only ever the `<img>`'s: reading them for
	// Save would be a cross-origin `fetch`, which fails on every host that sends
	// no CORS headers. Its own server is where to get it instead.
	const externalUrl =
		item.kind === "image" && item.source.kind === "external"
			? item.source.url
			: null;

	const save = async () => {
		if (savingRef.current) return;
		savingRef.current = true;
		setSaveError(null);
		try {
			await saveItem(queryClient, item, saveUrlRef.current);
		} catch (err) {
			setSaveError(`Couldn't save ${item.name}: ${errorMessage(err)}`);
		} finally {
			savingRef.current = false;
		}
	};

	// Navigating lands after the history entry is gone, or the Back that takes
	// it would undo the navigation.
	const openFiles = openInFiles && (() => closeThen(openInFiles));

	return (
		<Sheet
			title={item.name}
			subtitle={
				<div className="truncate text-xs text-th-text-muted">
					{caption(item, loaded)}
				</div>
			}
			onClose={close}
			fullScreen
			initialFocusRef={frameRef}
		>
			<div className="flex h-full flex-col text-xs">
				<div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-th-border px-3 pointer-coarse:min-h-11 sm:px-4">
					{/* The stage's own controls are portalled in here. */}
					<div
						ref={setToolbarStart}
						className="flex min-w-0 flex-1 items-center gap-1 pointer-coarse:gap-2"
					/>
					<div className="flex shrink-0 items-center gap-1 pointer-coarse:gap-2">
						{openFiles && (
							<button
								type="button"
								onClick={openFiles}
								aria-label="Open in Files"
								title="Open in Files"
								className={headerButtonClass("lg")}
							>
								<ExternalLink size={16} aria-hidden="true" />
							</button>
						)}
						{/* Last, nearest the thumb. */}
						{externalUrl ? (
							<a
								href={externalUrl}
								target="_blank"
								rel="noopener noreferrer"
								aria-label="Open original"
								title="Open original"
								className={headerButtonClass("lg")}
							>
								<Globe size={16} aria-hidden="true" />
							</a>
						) : (
							<button
								type="button"
								onClick={save}
								aria-label="Save"
								title="Save"
								className={headerButtonClass("lg")}
							>
								<Download size={16} aria-hidden="true" />
							</button>
						)}
					</div>
				</div>
				{item.kind === "html" && item.notice && <PageNotice />}
				{saveError && (
					<div
						role="alert"
						className="shrink-0 px-3 py-1 text-th-error sm:px-4"
					>
						{saveError}
					</div>
				)}
				{/* The viewer's rather than the stage's, so focus lands on the content
				    at open even before the stage's chunk arrives, and keys reach it
				    without focus moving when it does. */}
				<section
					ref={frameRef}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the keys drive the stage in it
					tabIndex={0}
					aria-label={item.name}
					onKeyDown={(event) => keysRef.current?.(event)}
					// A mouse press on the image is cancelled by the zoom library
					// (it starts a pan), which also cancels the focus it would
					// move here — leaving it on a toolbar button the keys never
					// reach from.
					onPointerDown={() => frameRef.current?.focus({ preventScroll: true })}
					className="relative min-h-0 flex-1 overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset"
				>
					{stage.status === "loaded" && (
						<stage.Stage
							item={item}
							toolbarStart={toolbarStart}
							keysRef={keysRef}
							onMetadata={setLoaded}
							saveUrlRef={saveUrlRef}
						/>
					)}
					{stage.status === "loading" && (
						<div className="absolute inset-0 flex items-center justify-center">
							<Spinner variant="current" className="text-th-text-muted" />
						</div>
					)}
					{stage.status === "failed" && (
						<div className="flex size-full items-center justify-center overflow-auto">
							<FileStateCard
								icon={CircleAlert}
								iconClassName="text-th-error"
								title={`Couldn't load the ${item.kind === "html" ? "page" : item.kind} viewer`}
								description={errorMessage(stage.error)}
								action={{ label: "Retry", onClick: retry }}
							/>
						</div>
					)}
				</section>
			</div>
		</Sheet>
	);
}
