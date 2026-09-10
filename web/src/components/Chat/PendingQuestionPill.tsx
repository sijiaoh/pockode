import { ArrowDown, ArrowUp, CircleHelp } from "lucide-react";

interface Props {
	/** Number of unanswered questions currently out of view. */
	count: number;
	/** Where the jump target sits relative to the viewport. */
	direction: "up" | "down";
	onClick: () => void;
}

function PendingQuestionPill({ count, direction, onClick }: Props) {
	const Arrow = direction === "up" ? ArrowUp : ArrowDown;
	const text = count === 1 ? "Question waiting" : `${count} questions waiting`;
	const label =
		count === 1
			? "Jump to unanswered question"
			: `Jump to ${count} unanswered questions`;

	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			// The pill floats over the message list, so its height is the layout;
			// `touch-target` lays the floor over it instead of growing it.
			className="touch-target pointer-events-auto flex h-9 animate-question-pill-in items-center gap-1.5 rounded-full border border-th-warning bg-th-bg-primary px-3 text-th-text-primary text-xs shadow-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent sm:h-10 sm:text-sm"
		>
			<CircleHelp
				className="size-4 shrink-0 text-th-warning"
				aria-hidden="true"
			/>
			<span>{text}</span>
			<Arrow
				className="size-3.5 shrink-0 text-th-text-muted"
				aria-hidden="true"
			/>
		</button>
	);
}

export default PendingQuestionPill;
