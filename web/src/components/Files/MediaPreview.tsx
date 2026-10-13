import { Maximize2 } from "lucide-react";
import { useState } from "react";
import { useInView } from "../../hooks/useInView";
import type { ContentOrigin } from "../../types/contents";
import {
	formatMediaCaption,
	inlineVideoBox,
	type PlayableKind,
} from "../../utils/fileView";
import { MediaViewer, type PlaybackHandoff } from "../Media";
import { MediaFailureCard } from "../Media/MediaFailureCard";
import { useMediaPlayback } from "../Media/useMediaPlayback";
import { headerButtonClass, Spinner } from "../ui";

interface Props {
	kind: PlayableKind;
	origin: ContentOrigin;
	fileName: string;
	mime: string;
	size: number;
	/** Offered when this browser cannot play the file. */
	downloadAction?: { label: string; onClick: () => void; disabled?: boolean };
}

/**
 * Audio or video playing in place, streamed from a raw capability once the
 * frame is on screen (docs/file.md, "Playing audio and video"). Native
 * controls: they are what each platform's users already know, and iOS draws
 * its own over a video regardless.
 *
 * The element is shown the moment it has a source, never held back until it
 * has loaded: iOS may not load a byte before the user presses play, and a
 * player hidden until then could never be started.
 *
 * A video opens in the media viewer from a button on the caption line, and
 * playback goes with it: the viewer carries on from the same second, and on
 * close this player picks up where the viewer left off, paused
 * (docs/media-viewer.md#files-and-git-mediapreview). Never render it inside a
 * sheet — the viewer is one, and sheets do not nest.
 */
function MediaPreview({
	kind,
	origin,
	fileName,
	mime,
	size,
	downloadAction,
}: Props) {
	const { ref, inView } = useInView<HTMLDivElement>();
	const playback = useMediaPlayback({ kind, origin, mime, size }, inView);
	const { metadata, mediaProps } = playback;
	// Where the viewer's player is, while it is open.
	const [handoff, setHandoff] = useState<PlaybackHandoff | null>(null);

	// The last child of both branches below, so this player failing or
	// reloading under the viewer leaves it open; it plays for itself.
	const viewer = handoff && (
		<MediaViewer
			item={{
				kind: "video",
				name: fileName,
				saveAs: fileName,
				mime,
				size,
				origin,
				dimensions: metadata?.dimensions ?? undefined,
				duration: metadata?.duration ?? undefined,
				handoff,
			}}
			onClose={() => {
				setHandoff(null);
				playback.takeBack(handoff.time);
			}}
		/>
	);

	if (playback.failure) {
		return (
			<>
				<MediaFailureCard
					kind={kind}
					failure={playback.failure}
					mime={mime}
					size={size}
					onRetry={playback.retry}
					downloadAction={downloadAction}
				/>
				{viewer}
			</>
		);
	}

	// A video track this browser cannot decode (HEVC in a Chromium without it)
	// plays its sound over black with no error, and an audio-only `.mp4` is
	// typed video too. Both are heard, so both are laid out as the sound they
	// are — on the same element, so playback carries on through the switch.
	const noPicture =
		kind === "video" && metadata !== null && !metadata.dimensions;
	const asAudio = kind === "audio" || noPicture;
	const spinner =
		playback.status === "waiting" || playback.status === "recovering";
	// Offered once there is a source rather than once loaded: iOS may load
	// nothing before a press of play, and the viewer loads it for itself.
	const canView = !asAudio && mediaProps.src !== undefined;

	return (
		<>
			<div className="flex flex-col items-center gap-2 p-4">
				<div
					ref={ref}
					className={`flex w-full flex-col items-center gap-2 rounded-lg border border-th-border bg-th-bg-secondary ${
						// The native audio control has a height of its own; the min-height
						// holds it while the source is asked for, so the swap moves nothing.
						asAudio ? "min-h-14 max-w-xl justify-center p-3" : "p-2"
					}`}
				>
					{noPicture && (
						<p className="text-center text-xs text-th-text-muted">
							No picture: this browser can't show this file's video, or it has
							none.
						</p>
					)}
					<div
						className="relative w-full"
						style={
							asAudio ? undefined : inlineVideoBox(metadata?.dimensions ?? null)
						}
					>
						{mediaProps.src !== undefined &&
							(kind === "video" ? (
								<video
									key={playback.key}
									{...mediaProps}
									aria-label={fileName}
									controls
									// Without it an iPhone takes any play straight into its own
									// full-screen player.
									playsInline
									className={
										noPicture
											? "block h-14 w-full"
											: "block size-full object-contain"
									}
								/>
							) : (
								<audio
									key={playback.key}
									{...mediaProps}
									aria-label={fileName}
									controls
									className="block w-full"
								/>
							))}
						{spinner && (
							<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
								<Spinner variant="current" className="text-th-text-muted" />
							</div>
						)}
					</div>
				</div>
				{/* The way into the viewer sits here, not on the picture's corner as
			    an image's does: a video's corners are the browser's own controls'. */}
				<div className="flex max-w-full items-center justify-center gap-2">
					<div className="min-w-0 truncate text-xs text-th-text-muted">
						{formatMediaCaption(mime, size, {
							dimensions: metadata?.dimensions,
							duration: metadata?.duration,
						})}
					</div>
					{canView && (
						<button
							type="button"
							onClick={() => setHandoff(playback.handOff())}
							aria-haspopup="dialog"
							aria-label="View full screen"
							title="View full screen"
							className={`shrink-0 ${headerButtonClass("lg")}`}
						>
							<Maximize2 size={16} aria-hidden="true" />
						</button>
					)}
				</div>
			</div>
			{viewer}
		</>
	);
}

export default MediaPreview;
