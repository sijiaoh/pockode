import { FileQuestion, VideoOff, VolumeX } from "lucide-react";
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
	const noun = kind === "video" ? "video" : "audio";
	const details = [
		{ label: "Type", value: getMimeType(mime) },
		{ label: "Size", value: formatBytes(size) },
	];
	const icon = kind === "video" ? VideoOff : VolumeX;

	switch (failure.kind) {
		case "unplayable":
			return (
				<FileStateCard
					icon={icon}
					iconClassName="text-th-error"
					title={
						kind === "video" ? "Video can't be played" : "Audio can't be played"
					}
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
					icon={FileQuestion}
					title="File not found"
					description="This file is no longer available."
				/>
			);
		case "load":
			return (
				<FileStateCard
					icon={icon}
					iconClassName="text-th-error"
					title={`Couldn't load ${noun}`}
					description={failure.error.message}
					details={details}
					action={{ label: "Retry", onClick: onRetry }}
				/>
			);
	}
}
