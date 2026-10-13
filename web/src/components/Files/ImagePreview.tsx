import { Maximize2 } from "lucide-react";
import { useState } from "react";
import { useImageSrc } from "../../hooks/useImageSrc";
import { useInView } from "../../hooks/useInView";
import {
	formatImageCaption,
	type ImageDimensions,
	type ImageSource,
} from "../../utils/fileView";
import { MediaViewer } from "../Media";
import { ImageFailureCard } from "../Media/ImageFailureCard";
import { headerButtonClass, Spinner } from "../ui";

interface Props {
	source: ImageSource;
	fileName: string;
	mime: string;
	size: number;
	/**
	 * What the bytes will turn out to be, when something already knows — an
	 * agent's content block reports them. Given here they reach the `<img>` as
	 * its `width`/`height` attributes, so the browser reserves the right box
	 * before the image decodes instead of growing into it. That matters in the
	 * transcript: the reader is held still through a picture growing near them,
	 * but whatever is on its far side from them moves on the screen either way
	 * (docs/agent-chat.md#where-the-view-sits).
	 */
	dimensions?: ImageDimensions;
}

type Status = "loading" | "loaded" | "error";

/**
 * An image at full size. Its bytes are read once the frame is on screen, the
 * same rule the strip's thumbnails follow, so nothing that shows an image
 * spends the connection on one nobody is looking at.
 *
 * Once loaded it opens in the media viewer (docs/media-viewer.md) without
 * Open in Files: in Files the file is already open, and a diff's or a commit's
 * image is not the work-directory file. Never render it inside a sheet — the
 * viewer is one, and sheets do not nest.
 */
function ImagePreview({ source, fileName, mime, size, dimensions }: Props) {
	const { ref, inView } = useInView<HTMLDivElement>();
	const image = useImageSrc(source, inView);
	const src = image.src;
	const [status, setStatus] = useState<Status>("loading");
	const [measured, setMeasured] = useState<ImageDimensions | null>(
		dimensions ?? null,
	);
	// Bumped to remount the <img>, since re-assigning the same src after a
	// failure does not make the browser try again.
	const [attempt, setAttempt] = useState(0);
	const [viewing, setViewing] = useState(false);

	// The file can be rewritten under us while the viewer is open, and a verdict
	// on the old bytes must not outlive them. Adjusted during render rather than
	// in an effect: an effect runs after the browser already has the new src, so
	// a fast decode could fire onLoad first and have this reset overwrite it —
	// leaving a loaded image behind a spinner that never clears.
	const [renderedSrc, setRenderedSrc] = useState(src);
	if (renderedSrc !== src) {
		setRenderedSrc(src);
		setStatus("loading");
		setMeasured(dimensions ?? null);
	}

	// The last child of both branches below, so a switch between them leaves it
	// mounted: the preview's copy failing, or reloading after a rewrite, must not
	// reset the zoom or the history entry of a viewer that reads its own bytes.
	const viewer = viewing && (
		<MediaViewer
			item={{
				kind: "image",
				name: fileName,
				saveAs: fileName,
				mime,
				size,
				source,
				dimensions,
			}}
			onClose={() => setViewing(false)}
		/>
	);

	if (image.error || status === "error") {
		return (
			<>
				<ImageFailureCard
					readError={image.error}
					mime={mime}
					size={size}
					onRetry={
						image.error
							? image.retry
							: () => {
									setStatus("loading");
									setAttempt((n) => n + 1);
								}
					}
				/>
				{viewer}
			</>
		);
	}

	return (
		<>
			<div className="flex flex-col items-center gap-2 p-4">
				{/* min-height holds the frame open while loading; the secondary
				    background keeps transparent images legible in both themes. */}
				<div
					ref={ref}
					className="relative flex min-h-[8rem] w-full items-center justify-center rounded-lg border border-th-border bg-th-bg-secondary p-2"
				>
					{src && (
						// biome-ignore lint/a11y/useKeyWithClickEvents: a pointer shortcut; the corner button is the accessible way in
						<img
							key={attempt}
							src={src}
							alt={fileName}
							width={dimensions?.width}
							height={dimensions?.height}
							onLoad={(event) => {
								setMeasured({
									width: event.currentTarget.naturalWidth,
									height: event.currentTarget.naturalHeight,
								});
								setStatus("loaded");
							}}
							onError={() => setStatus("error")}
							onClick={status === "loaded" ? () => setViewing(true) : undefined}
							// Hidden rather than unmounted: when a browser decodes a
							// `display: none` image is up to the browser.
							className={`max-h-[70vh] max-w-full object-contain ${
								status === "loading"
									? "invisible"
									: "pointer-fine:cursor-zoom-in"
							}`}
						/>
					)}
					{status === "loaded" && (
						// The one way in for the keyboard and a screen reader, and the
						// visible one on touch, where an image gives no hint it can be
						// tapped.
						<button
							type="button"
							onClick={() => setViewing(true)}
							aria-haspopup="dialog"
							aria-label="View full screen"
							title="View full screen"
							className={`absolute top-2 right-2 bg-th-bg-secondary/80 ${headerButtonClass("lg")}`}
						>
							<Maximize2 size={16} aria-hidden="true" />
						</button>
					)}
					{(!src || status === "loading") && (
						<div className="absolute inset-0 flex items-center justify-center">
							<Spinner variant="current" className="text-th-text-muted" />
						</div>
					)}
				</div>
				<div className="text-xs text-th-text-muted">
					{formatImageCaption(mime, size, measured)}
				</div>
			</div>
			{viewer}
		</>
	);
}

export default ImagePreview;
