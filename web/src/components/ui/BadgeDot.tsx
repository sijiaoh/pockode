/**
 * Which of the two things a badge is saying. `news` is the default because it
 * is what a badge usually means — something arrived here. `attention` is the
 * stronger one and the rarer one: someone is waiting on the user
 * (docs/lifecycle-ui.md §4), and it wears that section's hue so the badge and
 * the dot it stands for are never two colours for one meaning.
 */
export type BadgeDotTone = "news" | "attention";

const TONE_CLASS: Record<BadgeDotTone, string> = {
	news: "bg-th-accent",
	attention: "bg-th-warning",
};

interface Props {
	show: boolean;
	tone?: BadgeDotTone;
	className?: string;
}

/**
 * Notification badge dot indicator.
 * Use within a `relative` positioned parent.
 */
export default function BadgeDot({
	show,
	tone = "news",
	className = "",
}: Props) {
	if (!show) return null;
	return (
		<span
			className={`absolute h-2 w-2 rounded-full ${TONE_CLASS[tone]} ${className}`}
		/>
	);
}
