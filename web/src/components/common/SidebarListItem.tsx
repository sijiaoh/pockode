import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";
import { ACTIVITY_VIEW, type Activity } from "../../lib/activity";
import { ActivityIcon } from "../ui";

interface Props {
	title: ReactNode;
	subtitle?: ReactNode;
	isActive: boolean;
	/**
	 * What the row is doing. Three tiers, because the layers it is derived from
	 * are exclusive: anything but `idle` shows the activity, `idle` falls
	 * through to the unread dot, and the question glyph beside it is a second,
	 * independent dimension rather than a fourth tier
	 * (docs/lifecycle-ui.md §1.5).
	 */
	activity?: Activity;
	/**
	 * How many questions this row is waiting on an answer to. Drawn *beside* the
	 * activity indicator, never instead of it: an agent that posts a question
	 * keeps running, so the two are true at once and one glyph cannot say both.
	 */
	unansweredQuestions?: number;
	/** Whether anything has arrived since the row was last read. */
	unread?: boolean;
	leftSlot?: ReactNode;
	actions?: ReactNode;
	onSelect: () => void;
	ariaLabel?: string;
}

function SidebarListItem({
	title,
	subtitle,
	isActive,
	activity,
	unansweredQuestions = 0,
	unread,
	leftSlot,
	actions,
	onSelect,
	ariaLabel,
}: Props) {
	return (
		<div
			className={`group flex w-full min-h-[44px] items-center gap-2 rounded-lg transition-colors ${
				isActive
					? "bg-th-bg-tertiary border-l-2 border-th-accent"
					: "hover:bg-th-bg-tertiary"
			}`}
		>
			<button
				type="button"
				onClick={onSelect}
				className={`flex min-w-0 flex-1 items-center gap-2 py-2 pl-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset ${actions ? "rounded-l-lg" : "pr-3 rounded-lg"}`}
				aria-label={ariaLabel}
			>
				{leftSlot}
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm text-th-text-primary">{title}</div>
					{subtitle && (
						<div className="truncate text-xs text-th-text-muted">
							{subtitle}
						</div>
					)}
				</div>
				{/* The one animating surface in the app. A spinner asserts "output is
				    arriving right now", and this is the one place where liveness is
				    the question being asked — everywhere else uses the static glyph
				    (docs/lifecycle-ui.md §1.5). */}
				{activity === "running" ? (
					<output
						className="h-3 w-3 shrink-0 rounded-full border-2 border-th-accent border-t-transparent animate-spin"
						aria-label={ACTIVITY_VIEW.running.ariaLabel}
					/>
				) : activity && activity !== "idle" ? (
					<ActivityIcon activity={activity} size="sm" />
				) : (
					unansweredQuestions === 0 &&
					unread && (
						<span
							className="h-2 w-2 shrink-0 rounded-full bg-th-accent"
							aria-hidden="true"
						/>
					)
				)}
				{/* The second dimension, beside the first. The count is drawn only
				    above one: 1 is both the common case and the one that most needs
				    the width, so the glyph stands alone there — the label says the
				    number either way. */}
				{unansweredQuestions > 0 && (
					<span
						className="flex shrink-0 items-center gap-0.5"
						aria-label={
							unansweredQuestions === 1
								? "1 question waiting for your answer"
								: `${unansweredQuestions} questions waiting for your answer`
						}
						role="img"
					>
						{/* The hue is on the glyph alone, the way `ActivityIcon`
						    paints every warning leaf. The count beside it is *text* at
						    `text-xs`, and `text-th-warning` is 1.54–2.87 against these
						    surfaces in the five light variants — far under AA, where a
						    glyph owes only the 3:1 non-text floor and carries its
						    meaning in the label either way. */}
						<CircleHelp className="size-3 text-th-warning" aria-hidden="true" />
						{unansweredQuestions > 1 && (
							<span
								className="text-xs leading-none text-th-text-secondary"
								aria-hidden="true"
							>
								{unansweredQuestions}
							</span>
						)}
					</span>
				)}
			</button>
			{/* Wider on a coarse pointer: two 36px actions grow to 44px there, and
			    4px between them would leave their hit areas touching. */}
			{actions && (
				<div className="flex items-center gap-1 pr-2 pointer-coarse:gap-2">
					{actions}
				</div>
			)}
		</div>
	);
}

export default SidebarListItem;
