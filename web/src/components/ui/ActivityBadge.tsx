import {
	ACTIVITY_VIEW,
	type Activity,
	type ActivityTone,
} from "../../lib/activity";
import ActivityIcon from "./ActivityIcon";

/**
 * One shape for every tone: a semantic border carries the hue and a tint sits
 * behind it.
 *
 * This is the palette the work status badge carried, tone for tone, and the
 * reasoning it was written with holds unchanged. Every state used to tint and
 * letter itself in the same token, which fails AA in all light variants;
 * lowering the tint cannot fix that, so the hue moved to the border, where it
 * owes only the non-text floor. The warning tone — which the status badge never
 * reached and this one does, on all three "needs you" leaves — is the one that
 * still reads faint even there: `--th-warning` is too pale in the light
 * variants, and choosing a new value for it is a token-level change.
 *
 * `secondary` and `muted` have no hue to move: their fill is `bg-th-bg-tertiary`
 * rather than a tint, and `border-th-border` on it never reaches 1.3:1, so the
 * label is the only weight they have. It is `text-th-text-secondary` (6.90:1 at
 * worst) and not the body colour the other three take — a state is the least
 * important thing in a heading, and one that is finished, not yet started, or
 * quietly waiting on a machine should not read as loudly as one that is
 * running. That is what `text-th-text-muted` was saying at 2.23:1, and the
 * reason it had to be replaced rather than kept.
 *
 * The two tones share this palette and differ only in the glyph's colour, which
 * `ActivityIcon` applies: a badge already carries its label, so the distinction
 * the tone makes is only needed where the glyph stands alone.
 *
 * The table lives in the file that renders it, not in `activity.ts` beside the
 * tones: `web/tests/tint.test.ts` reads a tint and the foreground written on
 * the same element out of the source, and a palette in another module would be
 * a tint nothing checks.
 */
const TONE_CLASS: Record<ActivityTone, string> = {
	accent: "border-th-accent bg-th-accent/10 text-th-text-primary",
	warning: "border-th-warning bg-th-warning/10 text-th-text-primary",
	error: "border-th-error bg-th-error/10 text-th-text-primary",
	secondary: "border-th-border bg-th-bg-tertiary text-th-text-secondary",
	muted: "border-th-border bg-th-bg-tertiary text-th-text-secondary",
};

/**
 * An activity as a pill: glyph, then the state in words. For the surfaces with
 * room for words — the work detail heading. Rows use `ActivityIcon`.
 */
export default function ActivityBadge({ activity }: { activity: Activity }) {
	const { tone, label } = ACTIVITY_VIEW[activity];

	return (
		<span
			className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${TONE_CLASS[tone]}`}
		>
			<ActivityIcon activity={activity} size="sm" decorative />
			{label}
		</span>
	);
}
