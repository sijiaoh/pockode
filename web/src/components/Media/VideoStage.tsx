import { useEffect, useRef } from "react";
import { Spinner } from "../ui";
import { MediaFailureCard } from "./MediaFailureCard";
import type { StageKeyHandler, StageProps, VideoMediaItem } from "./types";
import { useMediaPlayback } from "./useMediaPlayback";

/** Seconds ← / → and j / l move by, as the common web players do. */
const SHORT_SEEK_S = 5;
const LONG_SEEK_S = 10;

/**
 * Keys a focused `<video controls>` acts on by itself (play/pause, seek,
 * volume). Acting on them again from the frame would undo or double what the
 * browser did; the letter keys no browser binds still work from there.
 */
const NATIVE_KEYS = new Set([
	" ",
	"Enter",
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
	"ArrowDown",
	"Home",
	"End",
]);

/**
 * A video on the full screen (docs/media-viewer.md#the-video-stage), played
 * through the same machine as the in-place preview — and from the same
 * capability, so opening it costs no round trip.
 *
 * No gestures of its own: a tap, a double-tap and a drag on the scrubber are
 * the browser's native controls', and there is nothing to zoom. Fitted to the
 * frame and enlarged to fill it, unlike an image: with no zoom, enlarging is
 * the only way a small clip gets bigger.
 */
export default function VideoStage({
	item,
	keysRef,
	onMetadata,
}: StageProps<VideoMediaItem>) {
	const playback = useMediaPlayback(
		{ kind: "video", origin: item.origin, mime: item.mime, size: item.size },
		true,
		item.handoff,
	);
	const { metadata, mediaProps, element } = playback;

	useEffect(() => onMetadata(metadata), [metadata, onMetadata]);

	const onKey: StageKeyHandler = (event) => {
		// A click on the video moves focus to it, and its keys bubble here.
		if (
			event.target instanceof HTMLMediaElement &&
			NATIVE_KEYS.has(event.key)
		) {
			return;
		}
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		const video = element.current;
		if (!video) return;
		const seekBy = (seconds: number) => {
			const end = Number.isFinite(video.duration) ? video.duration : Infinity;
			video.currentTime = Math.min(
				end,
				Math.max(0, video.currentTime + seconds),
			);
		};
		switch (event.key) {
			case " ":
			case "k":
				// Refused outside a gesture on some browsers; it stays paused.
				if (video.paused) video.play().catch(() => {});
				else video.pause();
				break;
			case "ArrowLeft":
				seekBy(-SHORT_SEEK_S);
				break;
			case "ArrowRight":
				seekBy(SHORT_SEEK_S);
				break;
			case "j":
				seekBy(-LONG_SEEK_S);
				break;
			case "l":
				seekBy(LONG_SEEK_S);
				break;
			case "m":
				video.muted = !video.muted;
				break;
			case "Home":
			case "0":
				video.currentTime = 0;
				break;
			default:
				return;
		}
		event.preventDefault();
	};
	const onKeyRef = useRef(onKey);
	onKeyRef.current = onKey;
	// Installed by the effect, for the reason `ImageStage` gives.
	useEffect(() => {
		keysRef.current = (event) => onKeyRef.current(event);
		return () => {
			keysRef.current = null;
		};
	}, [keysRef]);

	if (playback.failure) {
		// No Download on the card: Save is in the toolbar above it.
		return (
			<div className="absolute inset-0 flex items-center justify-center overflow-auto">
				<MediaFailureCard
					kind="video"
					failure={playback.failure}
					mime={item.mime}
					size={item.size}
					onRetry={playback.retry}
				/>
			</div>
		);
	}

	const noPicture = metadata !== null && !metadata.dimensions;
	const spinner =
		playback.status === "waiting" || playback.status === "recovering";

	return (
		// touch-none: a pinch must not zoom the app page under the sheet. The
		// native scrubber still drags (docs/media-viewer.md#the-video-stage).
		<div className="absolute inset-0 touch-none">
			{mediaProps.src !== undefined && (
				<video
					key={playback.key}
					{...mediaProps}
					aria-label={item.name}
					controls
					// Without it an iPhone takes any play into its own full-screen
					// player, leaving this one behind.
					playsInline
					className="absolute inset-0 size-full object-contain"
				/>
			)}
			{noPicture && (
				<p className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 px-4 text-center text-xs text-th-text-muted">
					No picture: this browser can't show this file's video, or it has none.
				</p>
			)}
			{spinner && (
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
					<Spinner variant="current" className="text-th-text-muted" />
				</div>
			)}
		</div>
	);
}
