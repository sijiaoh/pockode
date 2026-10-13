import { Film } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { AttachmentSource, FileBlock } from "../../types/content";
import {
	attachmentDetail,
	attachmentFileName,
	attachmentName,
} from "../../utils/attachment";
import type { PlayableKind } from "../../utils/fileView";
import type { VideoMediaItem } from "../Media";
import { DurationPill, PlayBadge } from "../Media/MediaBadges";
import { useMediaPlayback } from "../Media/useMediaPlayback";
import Skeleton from "../ui/Skeleton";
import MediaFailureChip from "./MediaFailureChip";
import PlayableAttachment, { type PlayableFile } from "./PlayableAttachment";

interface Props {
	file: FileBlock;
	source: AttachmentSource;
	/** Hands over what the media viewer plays for this video. */
	onOpen: (item: VideoMediaItem) => void;
	/** What it becomes when the file is described as audio. */
	other: (kind: PlayableKind) => ReactNode;
}

/**
 * One video in a message's attachment strip: its first frame as a poster, and
 * a press that opens it in the media viewer, already playing.
 *
 * Read the way an image thumbnail is — nothing until it is on screen — and
 * then only the description and what `preload="metadata"` asks for: the header
 * and the first frame, through Range requests, never the whole file.
 */
function VideoThumb({ file, source, onOpen, other }: Props) {
	const name = attachmentName(file);
	return (
		<PlayableAttachment
			file={file}
			source={source}
			kind="video"
			other={other}
			waiting={(boxRef) => <Placeholder name={name} boxRef={boxRef} />}
		>
			{(playable) => (
				<Poster file={file} name={name} {...playable} onOpen={onOpen} />
			)}
		</PlayableAttachment>
	);
}

/**
 * The square every state of the entry fills. A block carries no dimensions
 * for a video, so no shape is known before its bytes are; a square crops a
 * phone's 9:16 and a desktop's 16:9 alike to a recognisable centre, where a
 * guessed 16:9 box would letterbox the first to a sliver. The viewer shows the
 * whole frame.
 *
 * Written out at each call site rather than shared through a constant: the
 * hit-area scan reads the height off the class list where it is written.
 */
function Placeholder({
	name,
	boxRef,
}: {
	name: string;
	boxRef?: (node: HTMLDivElement | null) => void;
}) {
	return (
		<div
			ref={boxRef}
			className="size-24 shrink-0 overflow-hidden rounded-lg sm:size-32"
		>
			<Skeleton className="h-full w-full rounded-lg" label={name} />
		</div>
	);
}

interface PosterProps extends PlayableFile {
	file: FileBlock;
	name: string;
	onOpen: (item: VideoMediaItem) => void;
}

function Poster({ file, name, origin, mime, size, onOpen }: PosterProps) {
	// Mounted only once the thumbnail has been on screen.
	const playback = useMediaPlayback(
		{ kind: "video", origin, mime, size },
		true,
	);
	const { metadata, mediaProps } = playback;
	// The element whose first frame has painted, by key: a new element (a
	// rewrite, a worktree switch) is back to having shown nothing.
	const [painted, setPainted] = useState<string | null>(null);
	const saveAs = attachmentFileName(file);

	if (playback.failure) {
		return (
			<MediaFailureChip
				kind="video"
				failure={playback.failure}
				name={name}
				origin={origin}
				saveAs={saveAs}
				onRetry={playback.retry}
			/>
		);
	}

	if (mediaProps.src === undefined) return <Placeholder name={name} />;

	// No dimensions is a video with no picture this browser can show (HEVC in a
	// Chromium without it) or none at all (an audio-only `.mp4`): the frame it
	// "painted" is black, and the viewer says why.
	const framed = painted === playback.key && !!metadata?.dimensions;

	return (
		<button
			type="button"
			onClick={() =>
				onOpen({
					kind: "video",
					name,
					saveAs,
					mime,
					size,
					origin,
					dimensions: metadata?.dimensions ?? undefined,
					duration: metadata?.duration ?? undefined,
					// A press on a play mark means play. The poster never plays, so
					// there is nothing to take back when the viewer closes.
					handoff: { time: 0, playing: true },
				})
			}
			aria-haspopup="dialog"
			aria-label={`Play ${name}`}
			title={attachmentDetail(file) || undefined}
			// Black whatever the theme: it is what shows behind a frame that has
			// not painted, and a video frame is never transparent.
			className="relative size-24 shrink-0 overflow-hidden rounded-lg border border-th-border bg-th-media pointer-fine:cursor-pointer sm:size-32"
		>
			{/* No `controls`, so not interactive content: it may sit in a button.
			    `playsInline` keeps iOS from taking it full screen and `muted` keeps
			    it silent should anything ever start it; it is only ever a poster. */}
			<video
				key={playback.key}
				{...mediaProps}
				muted
				playsInline
				onLoadedData={() => setPainted(playback.key)}
				className="size-full object-cover"
			/>
			<PlayBadge />
			{/* Until a frame paints, and possibly for good — iOS may load nothing
			    before a press — the corner the length would take says "video". */}
			{!framed ? (
				<Film
					className="pointer-events-none absolute right-1.5 bottom-1.5 size-6 text-th-on-media/40"
					aria-hidden="true"
				/>
			) : (
				metadata?.duration != null && (
					<DurationPill seconds={metadata.duration} />
				)
			)}
		</button>
	);
}

export default VideoThumb;
