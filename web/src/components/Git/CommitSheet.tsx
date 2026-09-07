import { TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { StagedSubmodule } from "../../types/git";
import { Sheet, Spinner } from "../ui";

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

interface Props {
	/** Root-repository files this commit will record. */
	stagedCount: number;
	/** Staged files inside submodules, which this commit does not reach. */
	submodules: StagedSubmodule[];
	/** null before the first commit, where there is nothing to amend. */
	lastCommit: LastCommit | null;
	/** Opened from the `Amend last commit` button rather than from `Commit (n)`. */
	amendInitially: boolean;
	onClose: () => void;
	onCommit: (message: string, amend: boolean) => Promise<void>;
}

/** git's own words when it has no user.name / user.email to sign a commit with. */
const NO_IDENTITY =
	/Please tell me who you are|unable to auto-detect email address|empty ident name/i;

/**
 * Writes the commit message and records the commit.
 *
 * A sheet rather than a permanently mounted message box: the panel is 288px
 * wide and committing happens a few times an hour, so the textarea is worth one
 * extra tap and the room the sheet gives it.
 */
function CommitSheet({
	stagedCount,
	submodules,
	lastCommit,
	amendInitially,
	onClose,
	onCommit,
}: Props) {
	const canAmend = lastCommit !== null;
	const startsAmending = amendInitially && canAmend;
	const [amend, setAmend] = useState(startsAmending);
	const [message, setMessage] = useState(
		startsAmending && lastCommit ? lastCommit.message : "",
	);
	const [error, setError] = useState<string | null>(null);
	const [isCommitting, setIsCommitting] = useState(false);
	const messageRef = useRef<HTMLTextAreaElement>(null);
	const messageId = useId();

	useEffect(() => {
		messageRef.current?.focus();
	}, []);

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
		// back off only takes the prefill away while it is still untouched.
		if (next && message.trim() === "") {
			setMessage(lastCommit.message);
		} else if (!next && message === lastCommit.message) {
			setMessage("");
		}
	};

	// Nothing staged and not amending is a commit git is certain to refuse, and
	// the sheet opens in exactly that state whenever amend is switched back off.
	// Better a button that says it cannot run than a round trip that always ends
	// in "nothing to commit".
	const nothingToCommit = stagedCount === 0 && !amend;
	const canSubmit = message.trim() !== "" && !nothingToCommit && !isCommitting;

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = message.trim();
		if (!canSubmit) return;

		setError(null);
		setIsCommitting(true);
		try {
			await onCommit(trimmed, amend);
		} catch (err) {
			// The sheet stays open with the message intact: a rejected commit-msg
			// hook or a missing identity is fixed and retried from right here.
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setIsCommitting(false);
		}
	};

	return (
		<Sheet
			title="Commit"
			onClose={onClose}
			dismissible={!isCommitting}
			onSubmit={handleSubmit}
			footer={
				<>
					<button
						type="button"
						onClick={onClose}
						disabled={isCommitting}
						className="flex-1 rounded-lg bg-th-bg-tertiary px-4 py-2.5 text-sm text-th-text-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={!canSubmit}
						className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-th-accent px-4 py-2.5 text-sm text-th-accent-text transition-colors hover:bg-th-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
					>
						{/* The gerund label already announces the state; the spinner's
						    own "Loading" would only say it a second time. */}
						{isCommitting && <Spinner variant="current" srText={null} />}
						{isCommitting ? "Committing…" : "Commit"}
					</button>
				</>
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
						<p className="text-sm text-th-error">{summarize(error)}</p>
						<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-th-bg-tertiary p-2 font-mono text-xs text-th-text-secondary">
							{error}
						</pre>
					</div>
				)}

				<div className="space-y-1.5">
					<label htmlFor={messageId} className="sr-only">
						Commit message
					</label>
					<p className="text-sm text-th-text-secondary">
						{describeStaged(stagedCount, amend, canAmend)}
					</p>
					{submodules.map((sub) => (
						<p key={sub.path} className="text-xs text-th-text-muted">
							{files(sub.count, "staged")} in {sub.path} are not included
						</p>
					))}
					<textarea
						ref={messageRef}
						id={messageId}
						value={message}
						onChange={(e) => setMessage(e.target.value)}
						rows={3}
						disabled={isCommitting}
						placeholder="Commit message"
						className="max-h-60 min-h-[6rem] w-full resize-none overflow-y-auto rounded-lg border border-th-border bg-th-bg-primary px-3 py-2.5 text-th-text-primary placeholder:text-th-text-muted focus:border-th-border-focus focus:outline-none focus:ring-2 focus:ring-th-accent/20 disabled:opacity-50"
					/>
				</div>

				{canAmend && (
					<div className="space-y-2">
						<label className="flex items-center gap-2 text-sm text-th-text-primary">
							<input
								type="checkbox"
								checked={amend}
								onChange={(e) => toggleAmend(e.target.checked)}
								disabled={isCommitting}
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
										<p>
											This commit is already on {lastCommit.pushedTo} — pushing
											afterwards needs a force push.
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
