import { ImageOff } from "lucide-react";
import { useState } from "react";
import {
	useAttachmentContent,
	useAttachmentOrigin,
} from "../../hooks/useAttachmentContent";
import { useImageSrc } from "../../hooks/useImageSrc";
import { useInView } from "../../hooks/useInView";
import type { AttachmentSource, FileBlock } from "../../types/content";
import {
	attachmentDetail,
	attachmentFileName,
	attachmentName,
	omittedLabel,
} from "../../utils/attachment";
import { getFileViewState } from "../../utils/fileView";
import type { ImageMediaItem } from "../Media";
import Skeleton from "../ui/Skeleton";
import AttachmentChip from "./AttachmentChip";

/** Fallback shape for an image whose dimensions the agent did not report. */
const FALLBACK_ASPECT = 4 / 3;

interface Props {
	file: FileBlock;
	source: AttachmentSource;
	/** Hands over what the media viewer shows for this image. */
	onOpen: (item: ImageMediaItem) => void;
}

/**
 * One image in a tool result's attachment strip.
 *
 * Nothing is read until the thumbnail is scrolled into view — neither the
 * description nor the bytes: paging back through a transcript puts every image
 * the session ever produced into the DOM, and reading them all would spend the
 * connection on pictures nobody looked at.
 *
 * It renders through `<img>`, which is also what keeps an SVG safe: a browser
 * refuses scripts and external references in an image loaded that way, so
 * content from a tool never becomes content of this document.
 */
function AttachmentThumb({ file, source, onOpen }: Props) {
	const { ref, inView } = useInView<HTMLDivElement>();
	const origin = useAttachmentOrigin(source);
	const { data, error, refetch } = useAttachmentContent(source, inView);
	const view = data ? getFileViewState(data, origin) : null;
	const image = useImageSrc(
		view?.kind === "image" ? view.source : null,
		inView,
	);
	// Bumped to remount the <img>: re-assigning the same src after a failure
	// does not make the browser try again.
	const [attempt, setAttempt] = useState(0);
	const [decodeFailed, setDecodeFailed] = useState(false);

	const name = attachmentName(file);
	const aspect =
		file.width && file.height ? file.width / file.height : FALLBACK_ASPECT;

	if (error || image.error || decodeFailed) {
		return (
			<AttachmentChip
				icon={ImageOff}
				iconClassName="text-th-error"
				title={name}
				detail={
					decodeFailed ? "Image can't be displayed" : "Couldn't load image"
				}
				action={{
					label: "Retry",
					onClick: () => {
						// Only a read that failed is worth reading again. A decode
						// failure happened to bytes that are already here, so
						// remounting the <img> is the whole retry — refetching would
						// spend the connection re-sending content nothing is wrong
						// with.
						if (error) refetch();
						if (image.error) image.retry();
						setDecodeFailed(false);
						setAttempt((n) => n + 1);
					},
				}}
			/>
		);
	}

	// What arrived is not something the strip can draw — too large to send, or
	// not the image the agent's media type claimed. Why is what the reader needs
	// here, so the server's reason wins over the description; and where it sent
	// no reason, saying only its size would read as nothing being wrong. That
	// case is the same as a `binary` omission — content is there and none of it
	// can be drawn — so it is deliberately the same words.
	if (data && view && view.kind !== "image") {
		return (
			<AttachmentChip
				icon={ImageOff}
				title={name}
				detail={omittedLabel(data) ?? "Can't be previewed"}
				tooltip={attachmentDetail(file) || undefined}
			/>
		);
	}

	// The box is the same size in every state below — height from the class,
	// width from the aspect ratio — so the strip does not resize when the bytes
	// land, which is what would move the transcript under the reader. 96px is
	// about as tall as a thumbnail can be before one ordinary read fills half a
	// phone screen; a wider screen can afford 128.
	//
	// The two bounds are for the shapes a screenshot can take: a wide banner
	// would otherwise run to thousands of pixels of horizontal scrolling, and a
	// tall crop would come out a sliver too narrow to tap. Inside them the image
	// is letterboxed rather than cropped, which is what `object-contain` is for.
	//
	// Written out in both branches rather than shared through a constant: the
	// hit-area scan reads the height off the class list at the call site, and a
	// height arriving through a variable is a height it cannot check.
	if (!image.src || view?.kind !== "image") {
		return (
			<div
				ref={ref}
				className="h-24 min-w-11 max-w-full shrink-0 overflow-hidden rounded-lg sm:h-32"
				style={{ aspectRatio: aspect }}
			>
				<Skeleton className="h-full w-full rounded-lg" label={name} />
			</div>
		);
	}

	return (
		<button
			type="button"
			onClick={() =>
				onOpen({
					kind: "image",
					name,
					saveAs: attachmentFileName(file),
					mime: view.mime,
					size: view.size,
					source: view.source,
					dimensions:
						file.width && file.height
							? { width: file.width, height: file.height }
							: undefined,
				})
			}
			aria-haspopup="dialog"
			aria-label={`View ${name}`}
			// The secondary background is what keeps a transparent PNG legible in
			// both themes; `object-contain` keeps a wide screenshot from being
			// cropped to a square.
			className="h-24 min-w-11 max-w-full shrink-0 overflow-hidden rounded-lg border border-th-border bg-th-bg-secondary pointer-fine:cursor-zoom-in sm:h-32"
			style={{ aspectRatio: aspect }}
		>
			<img
				key={attempt}
				src={image.src}
				alt={name}
				onError={() => setDecodeFailed(true)}
				className="h-full w-full object-contain"
			/>
		</button>
	);
}

export default AttachmentThumb;
