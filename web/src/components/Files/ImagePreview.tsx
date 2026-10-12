import { ImageOff } from "lucide-react";
import { useState } from "react";
import { useImageSrc } from "../../hooks/useImageSrc";
import { useInView } from "../../hooks/useInView";
import { formatBytes } from "../../utils/bytes";
import {
	formatMimeLabel,
	getMimeType,
	type ImageSource,
} from "../../utils/fileView";
import { FileStateCard, Spinner } from "../ui";

interface Dimensions {
	width: number;
	height: number;
}

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
	dimensions?: Dimensions;
}

type Status = "loading" | "loaded" | "error";

/**
 * An image at full size. Its bytes are read once the frame is on screen, the
 * same rule the strip's thumbnails follow, so nothing that shows an image
 * spends the connection on one nobody is looking at.
 */
function ImagePreview({ source, fileName, mime, size, dimensions }: Props) {
	const { ref, inView } = useInView<HTMLDivElement>();
	const image = useImageSrc(source, inView);
	const src = image.src;
	const [status, setStatus] = useState<Status>("loading");
	const [measured, setMeasured] = useState<Dimensions | null>(
		dimensions ?? null,
	);
	// Bumped to remount the <img>, since re-assigning the same src after a
	// failure does not make the browser try again.
	const [attempt, setAttempt] = useState(0);

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

	const details = [
		{ label: "Type", value: getMimeType(mime) },
		{ label: "Size", value: formatBytes(size) },
	];

	if (image.error) {
		return (
			<FileStateCard
				icon={ImageOff}
				iconClassName="text-th-error"
				title="Couldn't load image"
				description={image.error.message}
				details={details}
				action={{ label: "Retry", onClick: image.retry }}
			/>
		);
	}

	if (status === "error") {
		return (
			<FileStateCard
				icon={ImageOff}
				iconClassName="text-th-error"
				title="Image can't be displayed"
				description="The browser couldn't decode this file."
				details={details}
				action={{
					label: "Retry",
					onClick: () => {
						setStatus("loading");
						setAttempt((n) => n + 1);
					},
				}}
			/>
		);
	}

	const caption = [
		formatMimeLabel(mime),
		measured && `${measured.width}×${measured.height}`,
		formatBytes(size),
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<div className="flex flex-col items-center gap-2 p-4">
			{/* min-height holds the frame open while loading; the secondary
			    background keeps transparent images legible in both themes. */}
			<div
				ref={ref}
				className="relative flex min-h-[8rem] w-full items-center justify-center rounded-lg border border-th-border bg-th-bg-secondary p-2"
			>
				{src && (
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
						// Hidden rather than unmounted: when a browser decodes a
						// `display: none` image is up to the browser.
						className={`max-h-[70vh] max-w-full object-contain ${
							status === "loading" ? "invisible" : ""
						}`}
					/>
				)}
				{(!src || status === "loading") && (
					<div className="absolute inset-0 flex items-center justify-center">
						<Spinner variant="current" className="text-th-text-muted" />
					</div>
				)}
			</div>
			<div className="text-xs text-th-text-muted">{caption}</div>
		</div>
	);
}

export default ImagePreview;
