import { type ReactNode, useState } from "react";
import type { AttachmentSource, FileBlock } from "../../types/content";
import {
	attachmentDetail,
	attachmentFileName,
	attachmentName,
} from "../../utils/attachment";
import { formatBytes } from "../../utils/bytes";
import { formatDuration, type PlayableKind } from "../../utils/fileView";
import { useMediaPlayback } from "../Media/useMediaPlayback";
import { ATTACHMENT_CHIP_BOX } from "../ui/AttachmentChip";
import AudioPlayButton from "./AudioPlayButton";
import MediaFailureChip from "./MediaFailureChip";
import PlayableAttachment, { type PlayableFile } from "./PlayableAttachment";

interface Props {
	file: FileBlock;
	source: AttachmentSource;
	/** What it becomes when the file is described as video. */
	other: (kind: PlayableKind) => ReactNode;
}

/**
 * One audio file in a message's attachment strip, played where it is: a voice
 * note is listened to beside the message it came with, not in a screen of its
 * own, so there is no audio stage to open.
 *
 * Read as a thumbnail is — nothing until it is on screen — and then only the
 * description and what `preload="metadata"` asks for; the rest streams through
 * Range requests once the user plays it.
 */
function AudioEntry({ file, source, other }: Props) {
	const name = attachmentName(file);
	return (
		<PlayableAttachment
			file={file}
			source={source}
			kind="audio"
			other={other}
			waiting={(boxRef) => (
				<EntryBox boxRef={boxRef}>
					<AudioPlayButton name={name} playing={false} disabled />
					<EntryText name={name} tooltip={file.path}>
						{attachmentDetail(file)}
					</EntryText>
				</EntryBox>
			)}
		>
			{(playable) => <Player file={file} name={name} {...playable} />}
		</PlayableAttachment>
	);
}

interface PlayerProps extends PlayableFile {
	file: FileBlock;
	name: string;
}

function Player({ file, name, origin, mime, size }: PlayerProps) {
	// Mounted only once the entry has been on screen.
	const playback = useMediaPlayback(
		{ kind: "audio", origin, mime, size },
		true,
	);
	// The element that has been played, by key: a new one (a rewrite, a
	// worktree switch) is back to never played. Held here rather than in the
	// controls, so it outlives a failure chip and the Retry that resumes.
	const [startedKey, setStartedKey] = useState<string | null>(null);

	if (playback.failure) {
		return (
			<MediaFailureChip
				kind="audio"
				failure={playback.failure}
				name={name}
				origin={origin}
				saveAs={attachmentFileName(file)}
				onRetry={playback.retry}
			/>
		);
	}

	// Keyed by the element, so a new one starts with nothing of the old one's
	// buffering.
	return (
		<Controls
			key={playback.key}
			file={file}
			name={name}
			size={size}
			playback={playback}
			started={startedKey === playback.key}
			onStart={() => setStartedKey(playback.key)}
		/>
	);
}

interface ControlsProps {
	file: FileBlock;
	name: string;
	size: number;
	playback: ReturnType<typeof useMediaPlayback>;
	/**
	 * Whether it has ever played: the scrubber appears with the first play and
	 * stays, so a paused or finished note still says where it got to.
	 */
	started: boolean;
	onStart: () => void;
}

function Controls({
	file,
	name,
	size,
	playback,
	started,
	onStart,
}: ControlsProps) {
	const { metadata, mediaProps, element, playing, position: time } = playback;
	const [buffering, setBuffering] = useState(false);

	const ready = mediaProps.src !== undefined;
	const duration = metadata?.duration ?? null;

	const toggle = () => {
		if (playing) {
			playback.pause();
			return;
		}
		// Called here, in the press, and on an element that already has its
		// source: iOS refuses a `play()` made outside the gesture. A refusal
		// leaves the button on Play, which is the truth; a source that cannot
		// play reports itself through the element's `error`.
		element.current?.play().catch(() => {});
	};

	return (
		<EntryBox active={playing}>
			{/* No `controls`: nothing of it is drawn. Native audio controls do not
			    fit a chip, and they look different on every browser. */}
			<audio
				{...mediaProps}
				onPlay={(event) => {
					mediaProps.onPlay(event);
					onStart();
				}}
				onPause={() => {
					mediaProps.onPause();
					setBuffering(false);
				}}
				onWaiting={() => setBuffering(true)}
				onPlaying={() => setBuffering(false)}
				// A new source swapped in under the element: nothing plays until it
				// has loaded and been put back.
				onEmptied={() => setBuffering(true)}
			/>
			<AudioPlayButton
				name={name}
				playing={playing}
				busy={(playing && buffering) || playback.status === "recovering"}
				disabled={!ready}
				onClick={toggle}
			/>
			<EntryText name={name} tooltip={file.path}>
				{started ? (
					<span className="flex items-center gap-2">
						{duration != null && (
							<input
								type="range"
								min={0}
								max={duration}
								step="any"
								value={Math.min(time, duration)}
								onChange={(event) => playback.seek(Number(event.target.value))}
								aria-label={`Seek ${name}`}
								aria-valuetext={`${formatDuration(time)} of ${formatDuration(duration)}`}
								// Under 44px on a touch screen on purpose: a scrubber is dragged
								// along its length, not tapped, and a 44px row would make the
								// entry taller than the chips beside it.
								className="h-4 min-w-0 flex-1 accent-th-accent pointer-coarse:h-6"
							/>
						)}
						<span className="shrink-0 tabular-nums">
							{duration != null
								? `${formatDuration(time)} / ${formatDuration(duration)}`
								: formatDuration(time)}
						</span>
					</span>
				) : duration != null ? (
					`${formatDuration(duration)} · ${formatBytes(size)}`
				) : (
					attachmentDetail(file)
				)}
			</EntryText>
		</EntryBox>
	);
}

/**
 * The box every state of the entry fills: `AttachmentChip`'s. With its 36 /
 * 44px button inside the `p-2` it is as tall as a chip with an action, so the
 * entry sits level in a row of chips and turning into one with Retry or Save
 * moves nothing. (One with no action is 8px shorter on a touch screen: a one-off,
 * on an entry that has nothing more to do.)
 */
function EntryBox({
	boxRef,
	active = false,
	children,
}: {
	boxRef?: (node: HTMLDivElement | null) => void;
	/** Marks which entry is sounding when several are on screen. */
	active?: boolean;
	children: ReactNode;
}) {
	return (
		<div
			ref={boxRef}
			className={`${ATTACHMENT_CHIP_BOX} ${
				active ? "border-th-accent" : "border-th-border"
			}`}
		>
			{children}
		</div>
	);
}

function EntryText({
	name,
	tooltip,
	children,
}: {
	name: string;
	tooltip?: string;
	children: ReactNode;
}) {
	return (
		<div className="min-w-0 flex-1 text-sm">
			<div className="truncate text-th-text-primary" title={tooltip ?? name}>
				{name}
			</div>
			<div className="truncate text-xs text-th-text-muted">{children}</div>
		</div>
	);
}

export default AudioEntry;
