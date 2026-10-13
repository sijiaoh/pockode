import { Play } from "lucide-react";
import { formatDuration } from "../../utils/fileView";

/**
 * `thumb` is a sent video's poster in the strip; `draft` is the composer's
 * smaller entry, whose top-right corner its remove button holds — and whose
 * hit area reaches into the box — so the length goes bottom-left there.
 */
type BadgeVariant = "thumb" | "draft";

const PLAY_BADGE = {
	thumb: { circle: "size-10", icon: "size-5" },
	draft: { circle: "size-6", icon: "size-3" },
} as const;

/**
 * The play mark over a video's poster: what says a thumbnail plays rather
 * than zooms, even before any frame of it has painted.
 */
export function PlayBadge({ variant = "thumb" }: { variant?: BadgeVariant }) {
	const size = PLAY_BADGE[variant];
	return (
		<span className="pointer-events-none absolute inset-0 flex items-center justify-center">
			<span
				className={`flex items-center justify-center rounded-full bg-th-media/55 text-th-on-media ${size.circle}`}
			>
				{/* Nudged right: a triangle's visual centre is left of its box's. */}
				<Play
					className={`translate-x-px fill-current ${size.icon}`}
					aria-hidden="true"
				/>
			</span>
		</span>
	);
}

const DURATION_PILL = {
	thumb: "right-1 bottom-1 px-1 text-[11px] leading-4",
	draft: "bottom-0.5 left-0.5 px-0.5 text-[10px] leading-3",
} as const;

/** A video's length in a bottom corner of its poster. */
export function DurationPill({
	seconds,
	variant = "thumb",
}: {
	seconds: number;
	variant?: BadgeVariant;
}) {
	return (
		<span
			className={`pointer-events-none absolute rounded bg-th-media/60 text-th-on-media tabular-nums ${DURATION_PILL[variant]}`}
		>
			{formatDuration(seconds)}
		</span>
	);
}
