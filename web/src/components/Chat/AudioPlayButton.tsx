import { Pause, Play } from "lucide-react";
import { Spinner } from "../ui";

/**
 * Play/pause for an audio file in place — a voice note in the strip, or one in
 * the composer before it is sent. The entry's one primary action, so accent
 * rather than `iconButtonClass`'s muted secondary weight; its box is that
 * helper's growing one.
 */
function AudioPlayButton({
	name,
	playing,
	busy = false,
	disabled = false,
	onClick,
}: {
	name: string;
	playing: boolean;
	busy?: boolean;
	disabled?: boolean;
	onClick?: () => void;
}) {
	const Icon = playing ? Pause : Play;
	return (
		<button
			type="button"
			onClick={onClick}
			// Disabled until there is a source, not shown as loading: nothing is
			// wrong yet, and a press that had to wait for one would land outside
			// the gesture iOS needs to start sound.
			disabled={disabled}
			aria-label={`${playing ? "Pause" : "Play"} ${name}`}
			className="flex min-h-[36px] min-w-[36px] shrink-0 items-center justify-center rounded-full text-th-accent hover:bg-th-overlay-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
		>
			{busy ? (
				// Hidden: the button's label already names it, and a status
				// region inside a button would be announced on its own.
				<span aria-hidden="true">
					<Spinner variant="current" srText={null} />
				</span>
			) : (
				<Icon className="size-5 fill-current" aria-hidden="true" />
			)}
		</button>
	);
}

export default AudioPlayButton;
