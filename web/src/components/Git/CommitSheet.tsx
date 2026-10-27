import { Sparkles, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { StagedSubmodule } from "../../types/git";
import { describeCommitDraftFailure } from "../../utils/commitDraftErrors";
import { describeGitFailure, type GitFailure } from "../../utils/gitErrors";
import { Sheet, Spinner } from "../ui";
import { inputClass } from "../ui/inputClass";
import GitOutput from "./GitOutput";

/** The commit amend would replace. */
export interface LastCommit {
	/** Its full message, prefilled when amend is turned on. */
	message: string;
	/**
	 * The upstream already containing it, null otherwise. Replacing a published
	 * commit is what turns the next push into a force push.
	 */
	pushedTo: string | null;
}

/** The push `Commit & push` would start once the commit succeeds. */
export interface CommitPush {
	/** No upstream to push to yet, so the push publishes the branch. */
	publishes: boolean;
	/**
	 * Why a plain push could not follow whatever is committed, null when it
	 * could. Amending a pushed commit is the sheet's own to work out.
	 */
	blocked: string | null;
}

/** The AI draft `Draft` asks for. */
export interface CommitDraft {
	/** The CLI that writes it, named while it runs. */
	agentLabel: string;
	/**
	 * Resolves to the drafted message, or to null for a draft dropped from
	 * outside the sheet — there is nothing to fill and nothing to report.
	 * Aborting `signal` stops the run on the server; whatever the promise does
	 * afterwards is ignored.
	 */
	run: (amend: boolean, signal: AbortSignal) => Promise<string | null>;
}

interface Props {
	/** Root-repository files this commit will record. */
	stagedCount: number;
	/** Staged files inside submodules, which this commit does not reach. */
	submodules: StagedSubmodule[];
	/** null before the first commit, where there is nothing to amend. */
	lastCommit: LastCommit | null;
	/** Opened from the HEAD row's amend action rather than from `Commit (n)`. */
	amendInitially: boolean;
	/** null where the sync chip is absent: no remote, or a detached HEAD. */
	push: CommitPush | null;
	draft: CommitDraft;
	onClose: () => void;
	onCommit: (message: string, amend: boolean, push: boolean) => Promise<void>;
}

/** Where `git log --oneline`, GitHub and most tools cut a title. */
const TITLE_LIMIT = 72;
/** Below this the title is short enough that a count would only be noise. */
const TITLE_HINT_FROM = 50;

/** git's own words when it has no user.name / user.email to sign a commit with. */
const NO_IDENTITY =
	/Please tell me who you are|unable to auto-detect email address|empty ident name/i;

/**
 * Writes the commit message and records the commit.
 *
 * A sheet rather than a permanently mounted message box: the changes list is
 * what the segment is for, and on a phone it has no room to spare; committing
 * happens a few times an hour, so the textarea is worth one extra tap and the
 * room the sheet gives it.
 */
function CommitSheet({
	stagedCount,
	submodules,
	lastCommit,
	amendInitially,
	push,
	draft,
	onClose,
	onCommit,
}: Props) {
	const canAmend = lastCommit !== null;
	const startsAmending = amendInitially && canAmend;
	const [amend, setAmend] = useState(startsAmending);
	const [message, setMessage] = useState(
		startsAmending && lastCommit ? lastCommit.message : "",
	);
	// The last text the sheet put in the box itself — amend's prefill or a
	// draft — and whether it was written for an amend. While the box still
	// holds it, it is not the user's to lose: replacing it is what redrafting
	// asks for, and turning amend off takes back what was written for amend.
	const [filled, setFilled] = useState<{ text: string; amend: boolean } | null>(
		startsAmending && lastCommit
			? { text: lastCommit.message, amend: true }
			: null,
	);
	const isUntouchedFill = filled !== null && message === filled.text;
	const [error, setError] = useState<GitFailure | null>(null);
	// One block per source: a draft failing leaves a commit failure on screen,
	// and the other way round.
	const [draftError, setDraftError] = useState<GitFailure | null>(null);
	const [draftStatus, setDraftStatus] = useState<
		"idle" | "asking" | "drafting"
	>("idle");
	const isDrafting = draftStatus === "drafting";
	// Taken with the run at the press: the engine can resolve differently
	// mid-run (a session's detail arriving late), and the row and the failure
	// have to name the CLI actually asked.
	const [draftingLabel, setDraftingLabel] = useState(draft.agentLabel);
	const [announcement, setAnnouncement] = useState("");
	const draftAbortRef = useRef<AbortController | null>(null);
	const draftButtonRef = useRef<HTMLButtonElement>(null);
	const replaceButtonRef = useRef<HTMLButtonElement>(null);
	// Which button started the commit, so only that one turns into a spinner.
	const [committing, setCommitting] = useState<"commit" | "push" | null>(null);
	const isCommitting = committing !== null;
	const messageRef = useRef<HTMLTextAreaElement>(null);
	const messageId = useId();
	const titleHintId = useId();
	const pushBlockedId = useId();
	const forcePushId = useId();

	useEffect(() => {
		messageRef.current?.focus();
	}, []);

	// Closing cancels: the draft's only destination is this box, and a CLI left
	// running would bill for an answer nobody can read.
	useEffect(() => () => draftAbortRef.current?.abort(), []);

	useEffect(() => {
		if (draftStatus === "asking") replaceButtonRef.current?.focus();
	}, [draftStatus]);

	// Grow with the message between the floor and the cap the classes set, so a
	// long message is written in the space it needs instead of a three-row
	// porthole. The floor has to be CSS rather than a starting `rows`: measuring
	// scrollHeight would otherwise collapse an empty box to a single line.
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the message rather than reading it, so the box is measured after React renders a new value — including the one amend prefills.
	useEffect(() => {
		const el = messageRef.current;
		if (!el) return;
		// Collapsed first: a box that has already grown never reports a smaller
		// scrollHeight on its own.
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [message]);

	const toggleAmend = (next: boolean) => {
		setAmend(next);
		if (!lastCommit) return;

		// Prefilling never overwrites what the user typed, and turning the toggle
		// back off only takes away what was written for the amend — the prefill,
		// or a draft that described HEAD's changes too — while it is untouched.
		if (next && message.trim() === "") {
			setMessage(lastCommit.message);
			setFilled({ text: lastCommit.message, amend: true });
		} else if (!next && isUntouchedFill && filled?.amend) {
			setMessage("");
		}
	};

	// Nothing staged and not amending is a commit git is certain to refuse, and
	// the sheet opens in exactly that state whenever amend is switched back off.
	// Better a button that says it cannot run than a round trip that always ends
	// in "nothing to commit".
	const nothingToCommit = stagedCount === 0 && !amend;
	// Disabled while drafting too: the message is about to be replaced.
	const canSubmit =
		message.trim() !== "" && !nothingToCommit && !isCommitting && !isDrafting;
	// With amend on and nothing staged there is still a message to redraft.
	const canDraft = !nothingToCommit && !isCommitting;
	// Rewriting a commit the upstream has makes the push a force push, which
	// stays behind the Sync sheet's confirmation.
	const amendNeedsForce = amend && Boolean(lastCommit?.pushedTo);
	const canPush = canSubmit && !push?.blocked && !amendNeedsForce;
	// The reason is on screen either way; this ties it to the dead button for a
	// screen reader, which would otherwise hear only "dimmed".
	const pushReasonId = push?.blocked
		? pushBlockedId
		: amendNeedsForce
			? forcePushId
			: undefined;

	const commit = async (withPush: boolean) => {
		const trimmed = message.trim();
		if (!(withPush ? canPush : canSubmit)) return;

		setError(null);
		setCommitting(withPush ? "push" : "commit");
		try {
			await onCommit(trimmed, amend, withPush);
		} catch (err) {
			// The sheet stays open with the message intact: a rejected commit-msg
			// hook, a missing identity or a worktree that was busy is fixed or
			// waited out and retried from right here.
			setError(describeGitFailure(err, summarize));
		} finally {
			setCommitting(null);
		}
	};

	const startDraft = async () => {
		// Re-checked here for the strip's Replace, which can be pressed after
		// a commit started or the index emptied under it.
		if (!canDraft) return;
		const { run, agentLabel } = draft;
		const controller = new AbortController();
		draftAbortRef.current = controller;
		setDraftError(null);
		setAnnouncement("");
		setDraftingLabel(agentLabel);
		setDraftStatus("drafting");
		// The button turns into Stop under the press; from the strip, focus
		// would otherwise fall to the page with the Replace button.
		draftButtonRef.current?.focus();
		const current = () => draftAbortRef.current === controller;
		try {
			const text = await run(amend, controller.signal);
			if (!current() || text === null) return;
			// Focus stays where it was: moving it to the box would raise the
			// on-screen keyboard over the draft the user now wants to read.
			setMessage(text);
			setFilled({ text, amend });
			setAnnouncement("Draft inserted");
		} catch (err) {
			if (!current()) return;
			setDraftError(describeCommitDraftFailure(err, agentLabel));
		} finally {
			if (current()) {
				draftAbortRef.current = null;
				setDraftStatus("idle");
			}
		}
	};

	const stopDraft = () => {
		// Nothing reported: the user knows why it stopped.
		draftAbortRef.current?.abort();
		draftAbortRef.current = null;
		setDraftStatus("idle");
	};

	const pressDraft = () => {
		if (isDrafting) {
			stopDraft();
			return;
		}
		if (!canDraft) return;
		// Only the user's own text is asked about; an untouched prefill or an
		// untouched earlier draft is what a redraft is meant to replace.
		const isOwnText = message.trim() !== "" && !isUntouchedFill;
		if (isOwnText) {
			setDraftStatus("asking");
		} else {
			startDraft();
		}
	};

	const keepMine = () => {
		setDraftStatus("idle");
		draftButtonRef.current?.focus();
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		commit(false);
	};

	const titleLength = [...subjectOf(message)].length;
	const titleTooLong = titleLength > TITLE_LIMIT;

	return (
		<Sheet
			title="Commit"
			onClose={onClose}
			dismissible={!isCommitting}
			onSubmit={handleSubmit}
			// No Cancel: three buttons do not fit at 320px, and the header's ✕,
			// the backdrop and Escape already close the sheet — disabled in
			// exactly the states Cancel was.
			footer={
				<div className="flex w-full flex-col gap-2">
					{/* In the footer rather than the body, which scrolls and would
					    carry the reason off-screen under a long message. */}
					{push?.blocked && (
						<p id={pushBlockedId} className="text-xs text-th-text-muted">
							{push.blocked}
						</p>
					)}
					<div className="flex gap-3">
						{push && (
							<button
								type="button"
								onClick={() => commit(true)}
								disabled={!canPush}
								aria-describedby={pushReasonId}
								className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-th-bg-tertiary px-4 py-2.5 text-sm text-th-text-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
							>
								{committing === "push" && (
									<Spinner variant="current" srText={null} />
								)}
								{committing === "push"
									? "Committing…"
									: push.publishes
										? "Commit & publish"
										: "Commit & push"}
							</button>
						)}
						<button
							type="submit"
							disabled={!canSubmit}
							className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-th-accent px-4 py-2.5 text-sm text-th-accent-text transition-colors hover:bg-th-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
						>
							{/* The gerund label already announces the state; the spinner's
							    own "Loading" would only say it a second time. */}
							{committing === "commit" && (
								<Spinner variant="current" srText={null} />
							)}
							{committing === "commit" ? "Committing…" : "Commit"}
						</button>
					</div>
				</div>
			}
		>
			<div className="space-y-4 p-4">
				{/* Above the message, not below it: pushed under a grown textarea the
				    one thing the user has to read would be the first off-screen. It
				    scrolls within its own cap for the same reason in reverse — a
				    pre-commit hook can dump a whole test run here, and that must not
				    push the message box out of view either. */}
				{error && (
					<div className="space-y-1" role="alert">
						<p className="text-sm text-th-error">{error.summary}</p>
						{/* Absent when the server refused before running git: there is
						    no output to quote, only the sentence above. */}
						{error.detail && <GitOutput>{error.detail}</GitOutput>}
					</div>
				)}

				<div className="space-y-1.5">
					<label htmlFor={messageId} className="sr-only">
						Commit message
					</label>
					<div className="flex items-center justify-between gap-2">
						{/* The count is not what the user reads while a draft runs;
						    whose time and quota is being spent is. */}
						<p className="flex min-w-0 items-center gap-2 text-sm text-th-text-secondary">
							{isDrafting && <Spinner variant="current" srText={null} />}
							{isDrafting
								? `Drafting with ${draftingLabel}…`
								: describeStaged(stagedCount, amend, canAmend)}
						</p>
						{/* One element for Draft and Stop, so focus stays on it when
						    one turns into the other. */}
						<button
							ref={draftButtonRef}
							type="button"
							onClick={pressDraft}
							disabled={!isDrafting && !canDraft}
							// The reason a dead Draft is dead is already on screen
							// (the staged line); only a screen reader needs it here.
							aria-label={
								!isDrafting && nothingToCommit
									? "Draft a message (nothing staged)"
									: undefined
							}
							className="flex min-h-[36px] shrink-0 items-center gap-1.5 rounded px-2 text-sm text-th-accent pointer-coarse:min-h-11 transition-colors hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent disabled:cursor-not-allowed disabled:opacity-50"
						>
							{isDrafting ? (
								"Stop"
							) : (
								<>
									<Sparkles className="h-4 w-4" aria-hidden="true" />
									Draft
								</>
							)}
						</button>
					</div>
					<p className="sr-only" aria-live="polite">
						{announcement}
					</p>
					{submodules.map((sub) => (
						<p key={sub.path} className="text-xs text-th-text-muted">
							{files(sub.count, "staged")} in {sub.path}{" "}
							{sub.count === 1 ? "is" : "are"} not included
						</p>
					))}
					{draftError && (
						<div className="space-y-1" role="alert">
							<p className="text-sm text-th-error">{draftError.summary}</p>
							{draftError.detail && <GitOutput>{draftError.detail}</GitOutput>}
						</div>
					)}
					{/* Inline, not a ConfirmDialog: sheets do not stack, and a modal
					    over a sheet reads worse on a phone than a line in it. */}
					{draftStatus === "asking" && (
						<fieldset
							aria-label="Replace your message"
							onKeyDown={(e) => {
								if (e.key !== "Escape") return;
								// Claimed, so the sheet's own Escape on `document`
								// does not close it along with the strip
								// (docs/answering-ui.md#who-owns-escape).
								e.stopPropagation();
								keepMine();
							}}
							className="min-w-0 space-y-2 rounded-lg border-0 bg-th-bg-tertiary px-3 py-2 text-xs text-th-text-secondary"
						>
							<p>Replace your message with an AI draft?</p>
							<div className="flex justify-end gap-2">
								<button
									type="button"
									onClick={keepMine}
									className="min-h-[36px] rounded px-3 text-th-text-primary pointer-coarse:min-h-11 transition-colors hover:bg-th-bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
								>
									Keep mine
								</button>
								<button
									ref={replaceButtonRef}
									type="button"
									onClick={startDraft}
									disabled={!canDraft}
									className="min-h-[36px] rounded bg-th-accent px-3 text-th-accent-text pointer-coarse:min-h-11 transition-colors hover:bg-th-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent disabled:cursor-not-allowed disabled:opacity-50"
								>
									Replace
								</button>
							</div>
						</fieldset>
					)}
					<textarea
						ref={messageRef}
						id={messageId}
						value={message}
						onChange={(e) => setMessage(e.target.value)}
						rows={3}
						disabled={isCommitting}
						// Read-only, not merely discouraged: text typed now would be
						// lost to the draft about to land here.
						readOnly={isDrafting}
						placeholder="Commit message"
						// Only once it matters: tied earlier, a screen reader would
						// read the count out on every keystroke.
						aria-describedby={titleTooLong ? titleHintId : undefined}
						className={`max-h-60 min-h-[6rem] w-full resize-none overflow-y-auto rounded-lg bg-th-bg-primary px-3 py-2.5 text-th-text-primary placeholder:text-th-text-muted disabled:opacity-50 read-only:opacity-50 ${inputClass}`}
					/>
					{/* Counted, never enforced: a long title is a convention broken,
					    not a commit git refuses. */}
					{titleLength >= TITLE_HINT_FROM && (
						<p
							id={titleHintId}
							className={`flex items-center justify-end gap-1 text-xs tabular-nums ${
								titleTooLong ? "text-th-text-secondary" : "text-th-text-muted"
							}`}
						>
							{/* The hue on the glyph, not the text: `text-th-warning` at
							    `text-xs` is far under AA in the light themes, while a
							    glyph owes only the 3:1 non-text floor. */}
							{titleTooLong && (
								<TriangleAlert
									className="h-3.5 w-3.5 text-th-warning"
									aria-hidden="true"
								/>
							)}
							{`Title ${titleLength} / ${TITLE_LIMIT}`}
						</p>
					)}
				</div>

				{canAmend && (
					<div className="space-y-2">
						<label className="flex items-center gap-2 text-sm text-th-text-primary">
							<input
								type="checkbox"
								checked={amend}
								onChange={(e) => toggleAmend(e.target.checked)}
								// Amend changes what a running draft describes.
								disabled={isCommitting || isDrafting}
								className="h-4 w-4 accent-th-accent"
							/>
							Amend last commit
						</label>

						{/*
						 * What amend replaces, shown instead of asked about: a modal
						 * stacked on a sheet would pose a question the user has no way
						 * to answer from inside it.
						 */}
						{amend && lastCommit && (
							<div className="flex gap-2 rounded-lg bg-th-bg-tertiary px-3 py-2 text-xs text-th-text-secondary">
								<TriangleAlert
									className="mt-0.5 h-3.5 w-3.5 shrink-0 text-th-warning"
									aria-hidden="true"
								/>
								<div className="min-w-0 space-y-1">
									<p className="truncate">
										Replaces “{subjectOf(lastCommit.message)}”
									</p>
									{lastCommit.pushedTo && (
										<p id={forcePushId}>
											This commit is already on {lastCommit.pushedTo} — pushing
											afterwards needs a force push from Sync.
										</p>
									)}
								</div>
							</div>
						)}
					</div>
				)}
			</div>
		</Sheet>
	);
}

/**
 * The identity failure is the one worth naming: on a phone the user cannot run
 * `git config`, and git's own instructions assume they can. Anything else keeps
 * git's message as the whole story rather than a guessed summary over it.
 */
function summarize(detail: string): string {
	if (NO_IDENTITY.test(detail)) {
		return "Commit failed: this repository has no git identity. Ask the agent in chat to set user.name and user.email.";
	}
	return "Commit failed.";
}

function describeStaged(
	count: number,
	amend: boolean,
	canAmend: boolean,
): string {
	if (count > 0) return `${files(count)} staged`;
	if (amend) return "Nothing staged — only the message changes";
	// Only where there is a commit to amend: in a repository without one,
	// pointing at amend would name a way out that does not exist.
	return canAmend
		? "Nothing staged — stage a file, or amend the last commit"
		: "Nothing staged";
}

function files(count: number, adjective = ""): string {
	const noun = count === 1 ? "file" : "files";
	return adjective ? `${count} ${adjective} ${noun}` : `${count} ${noun}`;
}

/** The first line of a commit message, which is what identifies it. */
function subjectOf(message: string): string {
	return message.split("\n", 1)[0];
}

export default CommitSheet;
