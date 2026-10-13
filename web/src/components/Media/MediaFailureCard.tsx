import { FileQuestion, type LucideIcon, VideoOff, VolumeX } from "lucide-react";
import { formatBytes } from "../../utils/bytes";
import { getMimeType, type PlayableKind } from "../../utils/fileView";
import { FileStateCard } from "../ui";
import type { MediaFailure } from "./useMediaPlayback";

interface Props {
	kind: PlayableKind;
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

/** The glyph for audio or video that is not there to play. */
export function mediaKindIcon(kind: PlayableKind): LucideIcon {
	return kind === "video" ? VideoOff : VolumeX;
}

/**
 * The icon and the few words that name a failure, for every surface that
 * reports one — this card and a chat attachment's chip — so a file that will
 * not play is called the same thing wherever it is met.
 */
export function mediaFailureHeadline(
	kind: PlayableKind,
	failure: MediaFailure,
): { icon: LucideIcon; iconClassName?: string; title: string } {
	const icon = mediaKindIcon(kind);
	const noun = kind === "video" ? "video" : "audio";
	switch (failure.kind) {
		case "unplayable":
			return {
				icon,
				iconClassName: "text-th-error",
				title:
					kind === "video" ? "Video can't be played" : "Audio can't be played",
			};
		case "gone":
			return { icon: FileQuestion, title: "File not found" };
		case "load":
			return {
				icon,
				iconClassName: "text-th-error",
				title: `Couldn't load ${noun}`,
			};
	}
}

/**
 * What stands in for audio or video that would not play, said the same way in
 * the in-place preview and the full-screen viewer.
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
