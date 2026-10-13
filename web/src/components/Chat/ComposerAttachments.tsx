import { Spinner } from "@pockode/shared";
import {
	CircleAlert,
	FileAudio,
	FileImage,
	FileText,
	FileVideo,
	Film,
	type LucideIcon,
	X,
} from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";
import type { DraftAttachment } from "../../lib/inputStore";
import type { AttachmentKind } from "../../utils/attachment";
import { formatBytes } from "../../utils/bytes";
import { formatDuration, mediaDuration } from "../../utils/fileView";
import { claimPlayback, releasePlayback } from "../Media/exclusivePlayback";
import { DurationPill, PlayBadge } from "../Media/MediaBadges";
import { FIRST_FRAME_FRAGMENT } from "../Media/useMediaPlayback";
import AudioPlayButton from "./AudioPlayButton";

interface Props {
	items: DraftAttachment[];
	onRemove: (key: string) => void;
}

/**
 * The files picked for the next message, above the draft.
 *
 * A failure is drawn as a chip whatever the file was, image or not: the reason
 * is the thing to read, and a thumbnail has no room for it. Send stays off
 * until the file is removed, so a picked file is never quietly left out.
 */
function ComposerAttachments({ items, onRemove }: Props) {
	return (
		// The remove button sits 4px inside each entry's corner, and its 44px
		// hit area reaches 12px past its 20px box — 8px past the entry, which is
		// the top and right padding. Any less and the scrolling box, which
		// clips on both axes, cuts the hit area and scrolls to show the rest.
		<ul
			aria-label="Attachments"
			className="flex gap-2 overflow-x-auto pt-2 pr-2 pb-2"
		>
			{items.map((item) => (
				<li key={item.key} className="relative shrink-0">
					<Entry item={item} />
					<button
						type="button"
						onClick={() => onRemove(item.key)}
						aria-label={`Remove ${item.name}`}
						className="touch-target absolute top-1 right-1 flex size-5 items-center justify-center rounded-full border border-th-border bg-th-bg-primary text-th-text-secondary hover:text-th-text-primary"
					>
						<X className="size-3" aria-hidden="true" />
					</button>
				</li>
			))}
		</ul>
	);
}

const FILE_ICON: Record<AttachmentKind, LucideIcon> = {
	image: FileImage,
	video: FileVideo,
	audio: FileAudio,
	file: FileText,
};

function Entry({ item }: { item: DraftAttachment }) {
	// A file the browser cannot open (HEIC outside Safari, HEVC in a Chromium
	// without it) falls back to a chip that says so.
	const [undrawable, setUndrawable] = useState(false);
	const uploading = item.status === "uploading";

	if (item.status === "failed") {
		const reason = item.error ?? "Upload failed";
		return (
			<div
				title={`${item.name}: ${reason}`}
				className="flex h-14 w-48 items-center gap-2 rounded-md border border-th-error bg-th-bg-secondary pr-7 pl-2"
			>
				<CircleAlert
					className="size-5 shrink-0 text-th-error"
					aria-hidden="true"
				/>
				<div className="min-w-0 text-sm">
					<div className="truncate text-th-text-primary">{item.name}</div>
					{/* Said aloud too: the spinner's status goes quietly, and Send
					    turns off with nothing else to say why. Two lines, not one
					    truncated: the end of a reason (the limit a file is over) is
					    the part to read, and two fit the entry's height. */}
					<div
						role="alert"
						className="line-clamp-2 break-words text-xs text-th-error"
					>
						{reason}
					</div>
				</div>
			</div>
		);
	}

	// The bar beside the spinner: a large recording takes minutes over a slow
	// link, and a spinner alone cannot tell that apart from one that is stuck.
	const percent = Math.round((item.progress ?? 0) * 100);
	const spinner = uploading && (
		<div className="absolute inset-0 flex items-center justify-center rounded-md bg-th-bg-primary/60">
			<Spinner srText={`Uploading ${item.name}`} />
			<div
				role="progressbar"
				aria-label={`${item.name} upload progress`}
				aria-valuenow={percent}
				aria-valuemin={0}
				aria-valuemax={100}
				className="absolute inset-x-1 bottom-1 h-0.5 overflow-hidden rounded-full bg-th-bg-tertiary"
			>
				<div
					className="h-full bg-th-accent transition-[width]"
					style={{ width: `${percent}%` }}
				/>
			</div>
		</div>
	);
	const onUndrawable = () => setUndrawable(true);

	if (item.previewUrl && !undrawable) {
		switch (item.kind) {
			case "image":
				return (
					<div className="relative size-14 overflow-hidden rounded-md border border-th-border bg-th-bg-secondary">
						<img
							src={item.previewUrl}
							alt={item.name}
							title={item.name}
							onError={onUndrawable}
							className="size-full object-cover"
						/>
						{spinner}
					</div>
				);
			case "video":
				return (
					<VideoEntry
						name={item.name}
						url={item.previewUrl}
						uploading={uploading}
						onUndrawable={onUndrawable}
					>
						{spinner}
					</VideoEntry>
				);
			case "audio":
				return (
					<AudioEntry
						name={item.name}
						size={item.size}
						url={item.previewUrl}
						onUndrawable={onUndrawable}
					>
						{spinner}
					</AudioEntry>
				);
		}
	}

	const Icon = FILE_ICON[item.kind];
	return (
		<div
			title={item.name}
			className="relative flex h-14 items-center gap-2 rounded-md border border-th-border bg-th-bg-secondary pr-7 pl-2"
		>
			<Icon className="size-5 shrink-0 text-th-text-muted" aria-hidden="true" />
			<div className="text-sm">
				<div className="max-w-40 truncate text-th-text-primary">
					{item.name}
				</div>
				<div className="text-xs text-th-text-muted">
					{formatBytes(item.size)}
					{undrawable && " · Can't be previewed"}
				</div>
			</div>
			{spinner}
		</div>
	);
}

interface VideoEntryProps {
	name: string;
	url: string;
	uploading: boolean;
	onUndrawable: () => void;
	children: ReactNode;
}

/**
 * A picked video's first frame, in the image entry's box: the box is there
 * before a frame is, so nothing moves when one paints — or when none ever
 * does, as iOS may not preload a `blob:` at all.
 *
 * Not tappable, as the image entries are not: the frame is the preview, and
 * playing a draft would need the viewer to take a `blob:` URL.
 */
function VideoEntry({
	name,
	url,
	uploading,
	onUndrawable,
	children,
}: VideoEntryProps) {
	const [painted, setPainted] = useState(false);
	const [duration, setDuration] = useState<number | null>(null);
	const label =
		duration == null
			? `${name}, video`
			: `${name}, video, ${formatDuration(duration)}`;

	return (
		<div
			title={name}
			// Black whatever the theme: a video frame is never transparent, and
			// black is what shows behind one that has not painted.
			className="relative size-14 overflow-hidden rounded-md border border-th-border bg-th-media"
		>
			{/* The upload spinner is outside the image: an image's children are
			    not read out — the video included, which is why it needs no
			    `aria-hidden` — and the spinner's status has to be. */}
			<div role="img" aria-label={label} className="absolute inset-0">
				{/* The fragment is what makes iOS paint the first frame, and
				    `preload="metadata"` reads no more than it. `playsInline` keeps
				    iOS from taking it full screen, `muted` keeps it silent should
				    anything ever start it; it is only ever a poster. */}
				<video
					src={`${url}${FIRST_FRAME_FRAGMENT}`}
					preload="metadata"
					muted
					playsInline
					onLoadedMetadata={(event) => {
						// No picture this browser can draw — HEVC in a Chromium
						// without it opens without an error and plays its sound
						// over black — is as undrawable as a file it cannot open.
						if (event.currentTarget.videoWidth === 0) onUndrawable();
						else setDuration(mediaDuration(event.currentTarget));
					}}
					onLoadedData={() => setPainted(true)}
					onError={onUndrawable}
					className="size-full object-cover"
				/>
				{/* Under the upload spinner's veil it would be a second overlay. */}
				{!uploading && <PlayBadge variant="draft" />}
				{/* The length once the header is read, frame or no frame: iOS may
				    read the header of a `blob:` and paint nothing. Until then the
				    corner it takes says "video". */}
				{duration != null ? (
					<DurationPill seconds={duration} variant="draft" />
				) : (
					!painted && (
						<Film
							className="pointer-events-none absolute bottom-0.5 left-0.5 size-5 text-th-on-media/40"
							aria-hidden="true"
						/>
					)
				)}
			</div>
			{children}
		</div>
	);
}

interface AudioEntryProps {
	name: string;
	size: number;
	url: string;
	onUndrawable: () => void;
	children: ReactNode;
}

/**
 * A picked audio file the user can listen to before sending, to check it is
 * the right voice note. No scrubber: that is all a draft needs.
 *
 * Fixed width, so its line gaining the length moves nothing beside it — the
 * failed chip's width, so an upload failing does not either. The upload
 * spinner veils the text and leaves the button: a note can be checked while it
 * is still on its way.
 */
function AudioEntry({
	name,
	size,
	url,
	onUndrawable,
	children,
}: AudioEntryProps) {
	const audio = useRef<HTMLAudioElement | null>(null);
	const [playing, setPlaying] = useState(false);
	const [duration, setDuration] = useState<number | null>(null);

	// A callback, so the element is let go of in the commit that removes it.
	const audioRef = useCallback((node: HTMLAudioElement | null) => {
		if (!node && audio.current) releasePlayback(audio.current);
		audio.current = node;
	}, []);

	const toggle = () => {
		const element = audio.current;
		if (!element) return;
		if (playing) {
			element.pause();
			return;
		}
		// In the press: iOS refuses a `play()` made outside the gesture. A
		// refusal leaves the button on Play, which is the truth; a file that
		// cannot play reports itself through the element's `error`.
		element.play().catch(() => {});
	};

	return (
		<div
			title={name}
			className="relative flex h-14 w-48 items-center gap-2 rounded-md border border-th-border bg-th-bg-secondary pr-7 pl-1"
		>
			{/* biome-ignore lint/a11y/useMediaCaption: a picked file comes with no captions to give it */}
			<audio
				ref={audioRef}
				src={url}
				preload="metadata"
				onLoadedMetadata={(event) =>
					setDuration(mediaDuration(event.currentTarget))
				}
				onPlay={(event) => {
					const element = event.currentTarget;
					// A `blob:` is never swapped under it, so pausing the element
					// is all it takes to stop it.
					claimPlayback(element, () => element.pause());
					setPlaying(true);
				}}
				onPause={() => setPlaying(false)}
				onError={onUndrawable}
			/>
			<AudioPlayButton name={name} playing={playing} onClick={toggle} />
			<div className="relative min-w-0 flex-1 self-stretch text-sm">
				<div className="flex h-full flex-col justify-center">
					<div className="truncate text-th-text-primary">{name}</div>
					<div className="truncate text-xs text-th-text-muted">
						{duration == null
							? formatBytes(size)
							: `${formatDuration(duration)} · ${formatBytes(size)}`}
					</div>
				</div>
				{children}
			</div>
		</div>
	);
}

export default ComposerAttachments;
