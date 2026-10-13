import {
	FileQuestion,
	FileWarning,
	type LucideIcon,
	VideoOff,
	VolumeX,
} from "lucide-react";
import { formatBytes } from "../../utils/bytes";
import { getMimeType, type PlayableKind } from "../../utils/fileView";
import { FileStateCard } from "../ui";
import type { MediaFailure } from "./useMediaPlayback";

interface Props {
	/** A page fails only to load: whatever a served page draws is its own. */
	kind: PlayableKind | "page";
	failure: MediaFailure;
	mime: string;
	size: number;
	onRetry: () => void;
	/**
	 * Offered for bytes this browser cannot play, which another app may well.
	 * Omitted where Save is already on screen.
	 */
	downloadAction?: { label: string; onClick: () => void; disabled?: boolean };
}

/** The glyph for audio, video or a page that is not there to show. */
export function mediaKindIcon(kind: PlayableKind | "page"): LucideIcon {
	return { video: VideoOff, audio: VolumeX, page: FileWarning }[kind];
}

/**
 * The icon and the few words that name a failure, for every surface that
 * reports one — this card and a chat attachment's chip — so a file that will
 * not play is called the same thing wherever it is met.
 */
export function mediaFailureHeadline(
	kind: PlayableKind | "page",
	failure: MediaFailure,
): { icon: LucideIcon; iconClassName?: string; title: string } {
	const icon = mediaKindIcon(kind);
	switch (failure.kind) {
		case "unplayable":
			return {
				icon,
				iconClassName: "text-th-error",
				title: `${kind === "video" ? "Video" : kind === "audio" ? "Audio" : "Page"} can't be played`,
			};
		case "gone":
			return { icon: FileQuestion, title: "File not found" };
		case "load":
			return {
				icon,
				iconClassName: "text-th-error",
				title: `Couldn't load ${kind}`,
			};
	}
}

/**
 * What stands in for audio, video or a page that would not play or load, said
 * the same way in the in-place preview and the full-screen viewer.
 */
export function MediaFailureCard({
	kind,
	failure,
	mime,
	size,
	onRetry,
	downloadAction,
}: Props) {
	const headline = mediaFailureHeadline(kind, failure);
	const details = [
		{ label: "Type", value: getMimeType(mime) },
		{ label: "Size", value: formatBytes(size) },
	];

	switch (failure.kind) {
		case "unplayable":
			return (
				<FileStateCard
					{...headline}
					description={
						getMimeType(mime) === "video/quicktime"
							? "This browser can't play this file. iPhone videos recorded in HEVC play in Safari and recent Chrome; otherwise, download it and open it in another app."
							: "This browser can't play this file."
					}
					details={details}
					action={downloadAction}
				/>
			);
		case "gone":
			return (
				<FileStateCard
					{...headline}
					description="This file is no longer available."
				/>
			);
		case "load":
			return (
				<FileStateCard
					{...headline}
					description={failure.error.message}
					details={details}
					action={{ label: "Retry", onClick: onRetry }}
				/>
			);
	}
}
