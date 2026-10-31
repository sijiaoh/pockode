import { useCoverPage } from "@pockode/shared";
import {
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	RotateCw,
} from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { useCanvasHistory } from "../../hooks/useCanvasHistory";
import type { CanvasReadOnly, SendRefusal } from "../../lib/canvasBridge";
import { useCanvasRevision } from "../../lib/canvasStore";
import type {
	CanvasChange,
	CanvasForkBlocked,
	CanvasHistoryEntry,
} from "../../types/canvas";
import { formatCompactDateTime, isInstant } from "../../utils/dateTime";
import { iconButtonClass, Sheet, Spinner } from "../ui";
import { CanvasFrame } from "./CanvasFrame";

interface Props {
	sessionId: string;
	/**
	 * The revision to open on: a canvas row's (**Show**), or null for the
	 * newest earlier page, which the list decides (docs/canvas-ui.md §15.1).
	 */
	initialRevision: number | null;
	/**
	 * The page was the current one while it was open before — the view
	 * reopened from the fork sheet's Cancel — so a newer page drawn meanwhile
	 * is still said to be (§15.4).
	 */
	initialWasCurrent?: boolean;
	onClose: () => void;
	/** Closes the view and switches to canvas view (§15.4). */
	onGoToCanvas: () => void;
	/**
	 * Forks from the page shown (§15.6); absent where no fork could ever be
	 * made — an agent that cannot fork — and Fork is not drawn.
	 */
	onFork?: (page: CanvasForkPage) => void;
}

/** The page a fork is asked for, and the line the fork sheet names it by. */
export interface CanvasForkPage {
	revision: number;
	/** `Canvas · revision 7 · updated · 14:02` */
	description: string;
	/** For reopening the view on it (`initialWasCurrent`). */
	wasCurrent: boolean;
}

/**
 * The page open, and whether it has been the current one while open — so a
 * newer page drawn since can be told from an earlier one (§15.4).
 */
interface Opened {
	revision: number;
	wasCurrent: boolean;
}

const CHANGE_WORDS: Record<CanvasChange["kind"], string> = {
	render: "drawn",
	update: "updated",
};

/** `updated · 14:02`, or what of it is known. */
function howAndWhen(kind: CanvasChange["kind"] | undefined, at?: string) {
	return [
		kind && CHANGE_WORDS[kind],
		isInstant(at) ? formatCompactDateTime(at) : undefined,
	]
		.filter(Boolean)
		.join(" · ");
}

/**
 * The newest page before the current one, or the current one when there is
 * no earlier — where the session panel's **History** opens (§15.1).
 */
function newestEarlier(
	entries: CanvasHistoryEntry[],
	current: number | null,
): number | undefined {
	const earlier = entries.find(
		(entry) => current === null || entry.revision < current,
	);
	return (earlier ?? entries[0])?.revision;
}

/** Why Fork cannot run on a page whose entry says so (§15.6). */
const FORK_BLOCKED_REASONS: Record<CanvasForkBlocked, string> = {
	pending: "Can't fork from this page until its call returns.",
	no_record:
		"Can't fork from this page: its call was never recorded in the conversation.",
	subagent:
		"Can't fork from this page: a subagent drew it, and a fork can't be cut inside a subagent's run.",
	superseded:
		"Can't fork from this page: a later page was drawn before its call returned.",
};

// A send from a read-only frame is refused by the frame before `onSend` is
// reached (§8.2), so this is never called.
const noSend = () => Promise.reject(new Error("read-only"));

const textButtonClass =
	"inline-flex min-h-9 shrink-0 items-center rounded px-1.5 font-medium text-th-accent hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent pointer-coarse:min-h-11";

/**
 * The history view (docs/canvas-ui.md §15): every page the agent drew, one at
 * a time, each the stored snapshot in a read-only `CanvasFrame` keyed by its
 * revision, so it is drawn whole and never patched. A `fullScreen` `Sheet`,
 * so Back, the cover and held navigations are the layer rules'.
 */
export function CanvasHistorySheet({
	sessionId,
	initialRevision,
	initialWasCurrent = false,
	onClose,
	onGoToCanvas,
	onFork,
}: Props) {
	const current = useCanvasRevision(sessionId);
	const [opened, setOpened] = useState<Opened | null>(() =>
		initialRevision === null
			? null
			: { revision: initialRevision, wasCurrent: initialWasCurrent },
	);
	const open = opened?.revision ?? null;
	const history = useCanvasHistory(sessionId, open);
	const { entries } = history;

	// History's own page waits for the list, which says which is the newest
	// earlier one.
	if (opened === null && entries !== null) {
		const pick = newestEarlier(entries, current);
		if (pick !== undefined) setOpened({ revision: pick, wasCurrent: false });
	}
	// Marked whenever it is current, not only on arrival: the current revision
	// may only become known after the page was opened.
	if (opened !== null && !opened.wasCurrent && opened.revision === current) {
		setOpened({ ...opened, wasCurrent: true });
	}

	// A refused send is answered beside the footer, until the page changes.
	const [refusedOn, setRefusedOn] = useState<number | null>(null);
	const go = (revision: number) => {
		setOpened({ revision, wasCurrent: false });
		setRefusedOn(null);
		setListOpen(false);
	};

	const [listOpen, setListOpen] = useState(false);
	const toggleRef = useRef<HTMLButtonElement>(null);
	const closeList = useCallback(() => {
		setListOpen(false);
		toggleRef.current?.focus();
	}, []);
	// The user opened it, so Back puts it away and leaves the view up.
	useCoverPage(listOpen, { onBack: closeList });
	// Escape too, wherever focus is below the header — the list or the footer
	// — claimed before `Sheet`'s `document` listener can see it
	// (docs/answering-ui.md#who-owns-escape).
	const claimEscape = (event: KeyboardEvent) => {
		if (event.key !== "Escape" || !listOpen) return;
		event.stopPropagation();
		closeList();
	};

	const onSendRefused = (code: SendRefusal) => {
		if (code === "readonly" && open !== null) setRefusedOn(open);
	};

	const isCurrent = open !== null && open === current;
	const readOnly: CanvasReadOnly = isCurrent ? "current" : "earlier";

	const entry = entries?.find((e) => e.revision === open);
	const snapshot =
		history.snapshot?.status === "loaded" ? history.snapshot.snapshot : null;
	const detail = howAndWhen(
		entry?.change_kind ?? snapshot?.change.kind,
		entry?.drawn_at ?? snapshot?.drawn_at,
	);

	// Fork, where it is drawn: runnable, blocked with the reason said beside
	// it, or disabled without one for the moment something is still loading
	// (§15.6). The server refuses every blocked case again.
	const fork: { runnable: boolean; reason: string | null } = (() => {
		if (history.snapshot?.status === "failed") {
			return { runnable: false, reason: "This page could not be read." };
		}
		if (entry?.fork_blocked) {
			return {
				runnable: false,
				reason: FORK_BLOCKED_REASONS[entry.fork_blocked],
			};
		}
		// An entry not listed yet — the list is read again on the push that
		// drew it — is still loading too.
		return { runnable: snapshot !== null && entry !== undefined, reason: null };
	})();
	const forkReasonId = useId();
	const startFork = () => {
		if (!onFork || !fork.runnable || listOpen || open === null) return;
		onFork({
			revision: open,
			description: `Canvas · revision ${open}${detail && ` · ${detail}`}`,
			wasCurrent: opened?.wasCurrent === true,
		});
	};

	// Revisions, not positions: one lost from disk is not listed, and a Show
	// of it still steps to its neighbours.
	const older =
		open === null ? undefined : entries?.find((e) => e.revision < open);
	const newer =
		open === null ? undefined : entries?.findLast((e) => e.revision > open);

	// At either end the arrow pressed is disabled, and focus would fall out of
	// the sheet's Tab trap to the page behind; ▾ takes it instead.
	const step = (revision: number) => {
		go(revision);
		const atEnd =
			entries?.at(-1)?.revision === revision ||
			entries?.[0]?.revision === revision;
		if (atEnd) toggleRef.current?.focus();
	};

	const renderBody = () => {
		if (listOpen && entries !== null && open !== null) {
			return (
				<RevisionList
					entries={entries}
					open={open}
					current={current}
					onPick={(revision) => {
						go(revision);
						closeList();
					}}
					onBack={closeList}
					onKeyDown={claimEscape}
				/>
			);
		}
		if (open === null) {
			if (entries === null) {
				return history.listError ? (
					<ReadFailure
						message={history.listError.message}
						onRetry={history.retryList}
					/>
				) : (
					<Centered>
						<Spinner />
					</Centered>
				);
			}
			return (
				<Centered>
					<p className="text-sm text-th-text-muted">
						No page of this canvas could be read.
					</p>
				</Centered>
			);
		}
		const read = history.snapshot;
		if (read === null || read.status === "loading") {
			// The page before is taken down, so an old page is never shown
			// under a new one's subtitle.
			return (
				<Centered>
					<Spinner />
				</Centered>
			);
		}
		if (read.status === "failed") {
			return (
				<ReadFailure
					message={read.error.message}
					onRetry={read.retryable ? history.retrySnapshot : undefined}
				/>
			);
		}
		return (
			<CanvasFrame
				key={read.snapshot.revision}
				sessionId={sessionId}
				canvas={read.snapshot}
				onSend={noSend}
				readOnly={readOnly}
				onSendRefused={onSendRefused}
				title={`Canvas revision ${read.snapshot.revision}`}
				className="flex-1"
			/>
		);
	};

	const renderNote = () => {
		if (open === null) return null;
		const superseded = !isCurrent && opened?.wasCurrent === true;
		// The fork's reason outranks a refused send: it says what the footer
		// can do. A failed list read is last — the page on screen is unaffected.
		const second =
			onFork && fork.reason ? (
				<p id={forkReasonId}>{fork.reason}</p>
			) : refusedOn === open ? (
				<p>
					Sends are off in history.
					{onFork &&
						fork.runnable &&
						" Fork from here to go on from this page."}
				</p>
			) : history.listError ? (
				// The page may be up without the list — Show reads it at once —
				// so a failed first read is said here too, not only in the body.
				<p className="flex items-center gap-1 text-th-error">
					<span className="min-w-0">
						{entries === null
							? "The list could not be read"
							: "The list could not be read again"}
						: {history.listError.message}
					</span>
					<button
						type="button"
						onClick={history.retryList}
						className={textButtonClass}
					>
						Retry
					</button>
				</p>
			) : null;
		return (
			<div className="text-xs text-th-text-muted">
				<p className="flex min-h-9 items-center gap-1 pointer-coarse:min-h-11">
					<span className="min-w-0 flex-1 truncate">
						{isCurrent
							? "Current page · read-only here"
							: superseded
								? "Earlier version · a newer page was drawn"
								: "Earlier version · read-only"}
					</span>
					{isCurrent && (
						<button
							type="button"
							onClick={onGoToCanvas}
							className={textButtonClass}
						>
							Go to canvas
						</button>
					)}
					{superseded && current !== null && (
						<button
							type="button"
							onClick={() => {
								go(current);
								// The button goes with the page it offered.
								toggleRef.current?.focus();
							}}
							className={textButtonClass}
						>
							Newest
						</button>
					)}
				</p>
				{second}
			</div>
		);
	};

	// The stepper waits for the list, which says what is before and after.
	const listLoading = entries === null;

	return (
		<Sheet
			title="Canvas history"
			subtitle={
				open !== null && (
					<div className="truncate text-xs text-th-text-muted">
						Revision {open}
						{detail && ` · ${detail}`}
					</div>
				)
			}
			onClose={onClose}
			fullScreen
			footer={
				// biome-ignore lint/a11y/noStaticElementInteractions: claims Escape for the revision list
				<div
					className="flex min-w-0 flex-1 flex-col gap-1"
					onKeyDown={claimEscape}
				>
					{renderNote()}
					<div className="flex items-center justify-between gap-2">
						<button
							type="button"
							onClick={() => older && step(older.revision)}
							disabled={listLoading || older === undefined || listOpen}
							aria-label="Older page"
							className={`${iconButtonClass()} text-th-text-secondary hover:bg-th-bg-tertiary hover:text-th-text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent`}
						>
							<ChevronLeft className="size-5" aria-hidden="true" />
						</button>
						<button
							ref={toggleRef}
							type="button"
							onClick={() => (listOpen ? closeList() : setListOpen(true))}
							disabled={listLoading || open === null}
							aria-expanded={listOpen}
							className="inline-flex min-h-9 min-w-0 items-center gap-1 rounded px-2 text-sm text-th-text-primary hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11"
						>
							<span className="truncate">
								{open === null
									? "Revision"
									: current === null
										? `Revision ${open}`
										: `Revision ${open} of ${current}`}
							</span>
							<ChevronDown
								className={`size-4 shrink-0 transition-transform ${listOpen ? "rotate-180" : ""}`}
								aria-hidden="true"
							/>
						</button>
						<button
							type="button"
							onClick={() => newer && step(newer.revision)}
							disabled={listLoading || newer === undefined || listOpen}
							aria-label="Newer page"
							className={`${iconButtonClass()} text-th-text-secondary hover:bg-th-bg-tertiary hover:text-th-text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent`}
						>
							<ChevronRight className="size-5" aria-hidden="true" />
						</button>
						{onFork && (
							// aria-disabled rather than disabled, so the button stays
							// reachable and its reason is read with it.
							<button
								type="button"
								onClick={startFork}
								aria-disabled={!fork.runnable || listOpen}
								aria-describedby={fork.reason ? forkReasonId : undefined}
								className="inline-flex min-h-9 shrink-0 items-center rounded-md bg-th-accent px-3 text-sm text-th-accent-text transition-colors hover:bg-th-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-offset-2 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-th-accent pointer-coarse:min-h-11"
							>
								Fork
							</button>
						)}
					</div>
				</div>
			}
		>
			{/* Exactly the body's height, so the only scroller is the frame's
			    area, as in canvas view: nested scrollers would fight over every
			    drag. Never measured (§5) — it is not canvas view's area. */}
			<div className="flex h-full flex-col bg-th-bg-primary">
				{renderBody()}
			</div>
		</Sheet>
	);
}

function Centered({ children }: { children: ReactNode }) {
	return (
		<div className="flex flex-1 items-center justify-center px-6 text-center">
			{children}
		</div>
	);
}

function ReadFailure({
	message,
	onRetry,
}: {
	message: string;
	/** Absent when nothing will bring the page back. */
	onRetry?: () => void;
}) {
	return (
		<Centered>
			<div className="space-y-2">
				<p className="text-sm text-th-error">{message}</p>
				{onRetry && (
					<button
						type="button"
						onClick={onRetry}
						className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-th-border px-3 text-sm text-th-text-primary hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent pointer-coarse:min-h-11"
					>
						<RotateCw className="size-4" aria-hidden="true" />
						Retry
					</button>
				)}
			</div>
		</Centered>
	);
}

const listRowClass =
	"flex min-h-[48px] w-full items-center gap-3 px-3 text-left text-sm text-th-text-primary transition-colors hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-th-accent";

/**
 * The revisions, newest first, in place of the page (sheets do not nest): a
 * layer of its own over the page, which Back and Escape return to.
 */
function RevisionList({
	entries,
	open,
	current,
	onPick,
	onBack,
	onKeyDown,
}: {
	entries: CanvasHistoryEntry[];
	open: number;
	current: number | null;
	onPick: (revision: number) => void;
	onBack: () => void;
	/** Claims Escape, which returns to the page. */
	onKeyDown: (event: KeyboardEvent) => void;
}) {
	const openRowRef = useRef<HTMLButtonElement>(null);
	const backRowRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		(openRowRef.current ?? backRowRef.current)?.focus();
	}, []);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: claims Escape for the list inside the sheet
		<div
			className="min-h-0 flex-1 overflow-y-auto bg-th-bg-secondary"
			onKeyDown={onKeyDown}
		>
			<button
				ref={backRowRef}
				type="button"
				onClick={onBack}
				className={`${listRowClass} border-b border-th-border font-medium`}
			>
				<ChevronLeft className="size-4 shrink-0" aria-hidden="true" />
				Back to revision {open}
			</button>
			<ul aria-label="Revisions">
				{entries.map((entry) => {
					const isOpen = entry.revision === open;
					return (
						<li key={entry.revision}>
							<button
								ref={isOpen ? openRowRef : undefined}
								type="button"
								onClick={() => onPick(entry.revision)}
								aria-current={isOpen || undefined}
								className={listRowClass}
							>
								<span className="min-w-0 flex-1 truncate">
									Revision {entry.revision} ·{" "}
									{entry.revision === current
										? "current"
										: howAndWhen(entry.change_kind, entry.drawn_at)}
								</span>
								{isOpen && (
									<Check
										className="size-4 shrink-0 text-th-accent"
										aria-hidden="true"
									/>
								)}
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
