import { Maximize2 } from "lucide-react";
import { useState } from "react";
import { useInView } from "../../hooks/useInView";
import type { TreeOrigin } from "../../types/contents";
import { formatMediaCaption } from "../../utils/fileView";
import { MediaViewer } from "../Media";
import { MediaFailureCard } from "../Media/MediaFailureCard";
import { PageReloadButton } from "../Media/PageReloadButton";
import { usePageFrame } from "../Media/usePageFrame";
import { headerButtonClass, Spinner } from "../ui";
import { PageHostsStrip } from "../ui/PageHostsStrip";

interface Props {
	origin: TreeOrigin;
	fileName: string;
	mime: string;
	size: number;
	/** See `usePageFrame`. */
	revision?: unknown;
}

/**
 * An HTML file rendered in place, filling the space between the header and
 * the bottom bar: the page's own scroll is the only one (docs/file.md, "HTML
 * pages"). Lay it out as the flexible child of a column, not inside a scroll
 * container.
 *
 * The page bar sits above the frame rather than under it as a video's caption
 * does: the frame runs down to the bottom bar, and two bars stacked there
 * would read as one.
 *
 * ⤢ opens the page in the media viewer, which loads it afresh at the entry
 * page; this frame stays where it is underneath, so closing returns the user
 * to their place in it (docs/media-viewer.md#files-and-git-pagepreview).
 * Never render it inside a sheet — the viewer is one, and sheets do not nest.
 */
function PagePreview({ origin, fileName, mime, size, revision }: Props) {
	const { ref, inView } = useInView<HTMLDivElement>();
	const [viewing, setViewing] = useState(false);
	// The revision this frame keeps to while the viewer is up, and until the
	// viewer's history entry is gone. Reloading under the viewer would add an
	// entry after the viewer's, and closing — which goes back to the entry
	// before it — would put this frame back on the page from before the edit.
	const [held, setHeld] = useState<{ revision: unknown } | null>(null);
	const page = usePageFrame(
		{ origin, fileName },
		inView,
		held ? held.revision : revision,
	);
	const { frameProps } = page;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-9 shrink-0 items-center gap-3 border-b border-th-border bg-th-bg-secondary px-3 text-xs text-th-text-muted">
				<div className="min-w-0 flex-1 truncate">
					{formatMediaCaption(mime, size)}
				</div>
				<PageReloadButton page={page} size="sm" />
				{/* Not a click on the frame: clicks there are the page's. */}
				{frameProps && !page.failure && (
					<button
						type="button"
						onClick={() => {
							setHeld({ revision });
							setViewing(true);
						}}
						aria-haspopup="dialog"
						aria-label="View full screen"
						title="View full screen"
						className={headerButtonClass("sm")}
					>
						<Maximize2 size={14} aria-hidden="true" />
					</button>
				)}
			</div>
			{frameProps && !page.failure && (
				<PageHostsStrip key={page.stripKey} {...page.strip} />
			)}
			<div ref={ref} className="relative min-h-0 flex-1 overflow-auto">
				{page.failure ? (
					<MediaFailureCard
						kind="page"
						failure={page.failure}
						mime={mime}
						size={size}
						onRetry={page.retry}
					/>
				) : frameProps ? (
					<iframe
						{...frameProps}
						key={page.frameKey}
						title={fileName}
						className="absolute inset-0 block size-full border-0 bg-white"
						style={{ colorScheme: "light" }}
					/>
				) : (
					<div className="flex h-full items-center justify-center">
						<Spinner variant="current" className="text-th-text-muted" />
					</div>
				)}
			</div>
			{/* Outside the branches above, so this frame failing or reloading
			    under the viewer leaves it open; it loads the page for itself. */}
			{viewing && (
				<MediaViewer
					item={{
						kind: "html",
						name: fileName,
						saveAs: fileName,
						mime,
						size,
						origin,
						revision,
					}}
					onClose={() => setViewing(false)}
					afterClose={() => setHeld(null)}
				/>
			)}
		</div>
	);
}

export default PagePreview;
