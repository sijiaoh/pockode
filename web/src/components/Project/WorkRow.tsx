import { MessageSquare } from "lucide-react";
import { type ReactNode, useId } from "react";
import { ACTIVITY_VIEW, needsUser } from "../../lib/activity";
import type { WorkListItem } from "../../types/work";
import { formatRelativeDate } from "../../utils/relativeTime";
import { ActivityIcon } from "../ui";
import { useWorktreeBadgeVisible, WorktreeBadge } from "../Worktree";
import WorkPrimaryAction, {
	countActiveChildren,
	StopConfirm,
	useWorkCommand,
} from "./WorkPrimaryAction";

interface Props {
	work: WorkListItem;
	/**
	 * The work's children, when it is a story: the two rollup slots, and what
	 * stopping it would cost. A task passes nothing.
	 */
	tasks?: WorkListItem[];
	/**
	 * Slot 2. The list passes a task's parent title; the story detail's children
	 * section passes nothing, because every row there is a task of the story on
	 * screen and naming it once per row is noise (docs/project-ui.md §3.1). It is
	 * the one slot decided by the screen rather than by the work.
	 */
	parentTitle?: string;
	/** Slot 4, resolved by the screen from the role map it already holds. */
	roleName?: string;
	/** Slot 7. The `Closed` segment is sorted by this, so only it shows it. */
	showUpdatedAt?: boolean;
	/**
	 * What the title is a heading of: `h3` under the list's group headings, `h4`
	 * under the detail page's Tasks heading. A row cannot know its own depth, and
	 * a list of rows that all claim the same level is a document a screen reader
	 * cannot walk.
	 */
	headingLevel?: 3 | 4;
	onOpen: (workId: string) => void;
	onOpenChat: (sessionId: string, worktree: string) => void;
}

/**
 * One work as a row: line 1 is what you can do to it, line 2 is what is true of
 * it, and line 3 — when it is there — is what happened when the user last tried
 * (docs/project-ui.md §3).
 *
 * The command lives here rather than inside the button because a failure has to
 * be written outside a glyph.
 *
 * The same component draws the project list and the story detail's children
 * section — the two places a work is ever listed — so the glyph, the two
 * controls and the seven slots are decided once. Nothing here reads the group a
 * row was sorted into: a control that moves between groups is a control the
 * user has to look for.
 */
export default function WorkRow({
	work,
	tasks,
	parentTitle,
	roleName,
	showUpdatedAt,
	headingLevel = 3,
	onOpen,
	onOpenChat,
}: Props) {
	const isNeedsUser = needsUser(work.activity);
	const isStopped = work.status === "stopped";
	const sessionId = work.session_id;
	const totalTasks = tasks?.length ?? 0;
	const closedTasks = tasks?.filter((t) => t.status === "closed").length ?? 0;
	const activeTasks = tasks ? countActiveChildren(tasks) : 0;
	const hasWorktreeBadge = useWorktreeBadgeVisible(work);
	const { action, busy, error, activate, confirm, confirmed, cancel } =
		useWorkCommand(work, activeTasks);
	const errorId = useId();

	// The bar keys off the leaves rather than the fields behind them: warning for
	// any of the three ways a work waits on the user, error for one the engine
	// has let go of. It is the only thing on the row that reads before a word
	// does, which is why slot 1 never has to spell "Stopped" out.
	const accentClass = isNeedsUser
		? "border-th-warning bg-th-warning/5"
		: isStopped
			? "border-th-error bg-th-error/5"
			: "border-transparent";

	// Fixed order, one appearance rule each, and the line clips from the right —
	// which is what puts the answer the user owes first and the timestamp last.
	const slots: { key: string; node: ReactNode }[] = [];
	if (isNeedsUser) {
		slots.push({
			key: "activity",
			node: (
				<span className="text-th-warning">
					{ACTIVITY_VIEW[work.activity].label}
				</span>
			),
		});
	}
	if (parentTitle) {
		slots.push({
			key: "parent",
			node: <span className="max-w-[10rem] truncate">in: {parentTitle}</span>,
		});
	}
	if (hasWorktreeBadge) {
		slots.push({
			key: "worktree",
			// Above the title's hit overlay: the badge leaves for the worktree, and
			// the row it sits on opens the work.
			//
			// It is also the one place the badge does not reach the 44px its own
			// `before:` overlay is for: that overlay is absolutely positioned
			// inside the badge, so the meta line's clip takes it back, leaving the
			// 20px box and the line's own padding — about 26px. Deliberate, and
			// the second of the two re-checks every reaching overlay owes
			// (docs/responsive-ui.md, blind spot 9): 11px below the badge is 5px
			// inside the *next* row, whose whole area is another work's target, so
			// the reach would have invented a band where aiming at one work
			// switches worktree. A miss here opens the work instead, which is
			// where its worktree is written anyway.
			node: (
				<span className="relative z-10">
					<WorktreeBadge work={work} className="max-w-[8rem]" />
				</span>
			),
		});
	}
	if (roleName) {
		slots.push({
			key: "role",
			node: <span className="max-w-[8rem] truncate">{roleName}</span>,
		});
	}
	if (work.type === "story" && activeTasks > 0) {
		// The same words the detail page's children header uses: not nesting tasks
		// costs the row "something under here is moving", and this is it.
		slots.push({ key: "active", node: <span>{activeTasks} active</span> });
	}
	if (work.type === "story" && totalTasks > 0) {
		slots.push({
			key: "tasks",
			node: (
				<span>
					{closedTasks}/{totalTasks} tasks
				</span>
			),
		});
	}
	if (showUpdatedAt) {
		slots.push({
			key: "updated",
			node: <span>{formatRelativeDate(work.updated_at)}</span>,
		});
	}

	const Heading = headingLevel === 4 ? "h4" : "h3";

	return (
		<div
			className={`relative rounded-lg border-l-2 px-2 hover:bg-th-bg-tertiary ${accentClass}`}
		>
			<div className="flex min-h-[44px] items-center gap-2">
				{/* Decorative: the title below names the leaf in the same breath, and
				    a glyph repeating it announces the row twice. */}
				<ActivityIcon activity={work.activity} decorative />
				<Heading className="min-w-0 flex-1 text-sm font-normal">
					{/* The whole row is the tap target — the overlay reaches the
					    padding and every line under this one, growing with the card
					    when line 3 appears — while staying one button a keyboard can
					    reach; the controls beside it lift themselves above it. The
					    height is stated as well as covered: the overlay is the
					    `::after` box and not this one, so it is the `min-h` that
					    answers to the floors in docs/responsive-ui.md. */}
					<button
						type="button"
						onClick={() => onOpen(work.id)}
						className="flex min-h-[44px] w-full items-center text-left text-sm text-th-text-primary after:absolute after:inset-0 after:content-[''] hover:text-th-accent"
						aria-label={`${work.title} — ${ACTIVITY_VIEW[work.activity].label}`}
					>
						{/* The ellipsis is the span's: `truncate` on the flex box above
						    would clip the title without one. */}
						<span className="truncate">{work.title}</span>
					</button>
				</Heading>
				<div className="relative z-10 flex shrink-0 items-center gap-2">
					{sessionId && (
						<button
							type="button"
							onClick={() => onOpenChat(sessionId, work.worktree ?? "")}
							className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-th-accent"
							aria-label={`Open chat for "${work.title}"`}
						>
							<MessageSquare className="size-3.5" />
						</button>
					)}
					<WorkPrimaryAction
						action={action}
						busy={busy}
						failed={!!error}
						errorId={error ? errorId : undefined}
						workTitle={work.title}
						onActivate={activate}
					/>
				</div>
			</div>

			{slots.length > 0 && (
				// The clip is what makes the line truncate from the right, and it
				// clips focus rings too — the worktree badge's is a `ring-2`
				// box-shadow with no room above it, or to its left when it is the
				// first slot. The 2px of padding is that room, and the matching
				// negative margins keep the row exactly as tall and as wide as it
				// was: half a focus ring is the one kind worse than none.
				<div className="-mx-0.5 -mt-0.5 flex items-center gap-1.5 overflow-hidden whitespace-nowrap px-0.5 pt-0.5 pb-1 text-xs text-th-text-muted">
					{slots.map((slot, i) => (
						// The separator belongs to the slot that follows it, so a slot
						// that is absent takes its separator with it.
						<span key={slot.key} className="flex shrink-0 items-center gap-1.5">
							{i > 0 && <span aria-hidden="true">&middot;</span>}
							{slot.node}
						</span>
					))}
				</div>
			)}

			{error && (
				// Wrapping rather than clamping: the list is the only place this is
				// ever written — the detail page holds its own command state and this
				// row unmounts on the way there — so a clamp would lose the text with
				// nowhere left to read it. Not lifted above the row's overlay, and no
				// dismiss control: tapping it opens the work, like the rest of the
				// card.
				<p
					id={errorId}
					className="pb-1.5 text-xs break-words text-th-error"
					role="alert"
				>
					{error}
				</p>
			)}

			{confirm && (
				<StopConfirm
					message={confirm}
					onConfirm={confirmed}
					onCancel={cancel}
				/>
			)}
		</div>
	);
}
