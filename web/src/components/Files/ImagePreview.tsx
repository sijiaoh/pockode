import { ImageOff } from "lucide-react";
import { useState } from "react";
import { formatBytes } from "../../utils/bytes";
import { formatMimeLabel, getMimeType } from "../../utils/fileView";
import { FileStateCard, Spinner } from "../ui";

interface Props {
	src: string;
	fileName: string;
	mime: string;
	size: number;
}

type Status = "loading" | "loaded" | "error";

interface Dimensions {
	width: number;
	height: number;
}

function ImagePreview({ src, fileName, mime, size }: Props) {
	const [status, setStatus] = useState<Status>("loading");
	const [dimensions, setDimensions] = useState<Dimensions | null>(null);
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
		setDimensions(null);
	}

	if (status === "error") {
		return (
			<FileStateCard
				icon={ImageOff}
				iconClassName="text-th-error"
				title="Image can't be displayed"
				description="The browser couldn't decode this file."
				details={[
					{ label: "Type", value: getMimeType(mime) },
					{ label: "Size", value: formatBytes(size) },
				]}
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
		dimensions && `${dimensions.width}×${dimensions.height}`,
		formatBytes(size),
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<div className="flex flex-col items-center gap-2 p-4">
			{/* min-height holds the frame open while loading; the secondary
			    background keeps transparent images legible in both themes. */}
			<div className="relative flex min-h-[8rem] w-full items-center justify-center rounded-lg border border-th-border bg-th-bg-secondary p-2">
				<img
					key={attempt}
					src={src}
					alt={fileName}
					onLoad={(event) => {
						setDimensions({
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
				{status === "loading" && (
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
