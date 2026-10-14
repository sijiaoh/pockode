import { type FocusEvent, useEffect } from "react";
import { createPortal } from "react-dom";
import { splitPath } from "../../utils/path";
import { Spinner } from "../ui";
import { PageHostsStrip } from "../ui/PageHostsStrip";
import { MediaFailureCard } from "./MediaFailureCard";
import { PageReloadButton } from "./PageReloadButton";
import type { HtmlMediaItem, StageProps } from "./types";
import { usePageFrame } from "./usePageFrame";

/**
 * Tab past the page's last element. A key pressed in a cross-origin frame
 * never reaches this document, so the sheet's Tab trap does not see it, and
 * focus lands here, the next stop after the frame: it goes on to the sheet's
 * first control, as the trap would have sent it. Arriving from outside the
 * stage's frame instead — ✕, or the sheet's box — is the trap wrapping
 * Shift+Tab round to its last stop, which this is: focus goes back to the
 * page.
 */
function keepTabInSheet(event: FocusEvent<HTMLElement>) {
	const sentinel = event.currentTarget;
	const stageFrame = sentinel.parentElement;
	const from = event.relatedTarget;
	if (stageFrame && from instanceof Node && !stageFrame.contains(from)) {
		stageFrame.querySelector("iframe")?.focus();
		return;
	}
	// Every control ahead of the stage in the viewer is a button.
	sentinel
		.closest('[role="dialog"]')
		?.querySelector<HTMLElement>("button:not([disabled])")
		?.focus();
}

/**
 * An HTML page on the full screen (docs/media-viewer.md#the-html-stage),
 * through the same frame machine as the in-place page, and its cached
 * capability while the hosts allowed for the page are the ones that was drawn
 * with. It loads afresh at the entry page: an opaque-origin page's
 * place and state cannot be read, so there is nothing to hand over.
 *
 * No gestures and no keys of its own — every touch, scroll, pinch and key in
 * the frame is the page's, and Escape pressed there never reaches the sheet.
 */
export default function HtmlStage({
	item,
	toolbarStart,
	onMetadata,
	saveUrlRef,
}: StageProps<HtmlMediaItem>) {
	const page = usePageFrame(
		{
			origin: item.origin,
			fileName: splitPath(item.origin.path).fileName,
			unreachableFolder: item.unreachableFolder,
		},
		true,
		item.revision,
	);
	const { frameProps } = page;

	// A page has nothing to add to the caption.
	useEffect(() => {
		onMetadata(null);
	}, [onMetadata]);

	useEffect(() => {
		saveUrlRef.current = page.url;
		return () => {
			saveUrlRef.current = null;
		};
	}, [saveUrlRef, page.url]);

	return (
		<>
			{toolbarStart &&
				createPortal(<PageReloadButton page={page} size="lg" />, toolbarStart)}
			{page.failure ? (
				// No Download on the card: Save is in the toolbar above it.
				<div className="absolute inset-0 flex items-center justify-center overflow-auto">
					<MediaFailureCard
						kind="page"
						failure={page.failure}
						mime={item.mime}
						size={item.size}
						onRetry={page.retry}
					/>
				</div>
			) : frameProps ? (
				// The strip is under the toolbar and the notice, as in place.
				<div className="absolute inset-0 flex flex-col">
					<PageHostsStrip key={page.stripKey} {...page.strip} />
					<div className="relative min-h-0 flex-1">
						<iframe
							{...frameProps}
							key={page.frameKey}
							title={item.name}
							className="absolute inset-0 block size-full border-0 bg-white"
							style={{ colorScheme: "light" }}
						/>
						{/* biome-ignore lint/a11y/noStaticElementInteractions: a focus sentinel, never a stop of its own; see `keepTabInSheet` */}
						<div
							// biome-ignore lint/a11y/noNoninteractiveTabindex: as above
							tabIndex={0}
							onFocus={keepTabInSheet}
							className="absolute size-0 overflow-hidden"
						/>
					</div>
				</div>
			) : (
				<div className="absolute inset-0 flex items-center justify-center">
					<Spinner variant="current" className="text-th-text-muted" />
				</div>
			)}
		</>
	);
}
