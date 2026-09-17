import {
	ACTIVITY_VIEW,
	type Activity,
	type ActivityTone,
} from "../../lib/activity";

interface Props {
	activity: Activity;
	size?: "sm" | "default";
	/**
	 * The glyph is beside something that already names the state — the badge's
	 * own label, a group header — so it drops its `aria-label` rather than
	 * announcing it a second time.
	 */
	decorative?: boolean;
}

/** A tone as the colour of a glyph standing on its own. */
function glyphClass(tone: ActivityTone): string {
	switch (tone) {
		case "accent":
			return "text-th-accent";
		case "warning":
			return "text-th-warning";
		case "error":
			return "text-th-error";
		case "secondary":
			return "text-th-text-secondary";
		case "muted":
			return "text-th-text-muted";
	}
}

/**
 * An activity as a glyph and nothing else. Session rows today; work rows and
 * group headers when the work layer sends an activity of its own.
 *
 * It renders no button and takes no handler, here or anywhere. A 12px glyph that
 * could be tapped is a 12px glyph somebody will try to tap
 * (docs/lifecycle-ui.md §10).
 */
export default function ActivityIcon({
	activity,
	size = "default",
	decorative,
}: Props) {
	const { Icon, tone, ariaLabel } = ACTIVITY_VIEW[activity];
	const base = size === "sm" ? "size-3 shrink-0" : "size-3.5 shrink-0";

	return (
		<Icon
			className={`${base} ${glyphClass(tone)}`}
			aria-label={decorative ? undefined : ariaLabel}
			aria-hidden={decorative ? "true" : undefined}
		/>
	);
}
