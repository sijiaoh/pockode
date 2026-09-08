import { ConfirmDialog } from "@pockode/shared";
import { ArrowDown, ArrowUp, RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { describeGitSync, type GitSync } from "../../types/git";
import { formatRelativeDate } from "../../utils/relativeTime";
import { Sheet, Spinner } from "../ui";
import GitOutput from "./GitOutput";

type Operation = "fetch" | "pull" | "push";

interface Props {
	sync: GitSync;
	onClose: () => void;
	onFetch: () => Promise<void>;
	/** Resolves to the number of commits the fast-forward brought in. */
	onPull: () => Promise<number>;
	onPush: (force: boolean) => Promise<void>;
}

/** git's own words when --ff-only meets a diverged branch. */
const DIVERGED = /not possible to fast-forward|divergent branches/i;
/** --force-with-lease when the remote moved since our last fetch. */
const STALE_LEASE = /stale info/i;
/** A plain push whose remote holds commits we do not have. */
const BEHIND_REMOTE = /fetch first|non-fast-forward/i;

/**
 * Fetch, pull and push — the only operations in the panel with no bound on how
 * long they take.
 *
 * The sheet stays open after one succeeds: over a slow relay link, a sheet that
 * closes by itself leaves the user unsure whether anything happened at all.
 */
function SyncSheet({ sync, onClose, onFetch, onPull, onPush }: Props) {
	const [running, setRunning] = useState<Operation | null>(null);
	const [error, setError] = useState<{
		summary: string;
		detail: string;
	} | null>(null);
	const [result, setResult] = useState<string | null>(null);
	const [confirmingForce, setConfirmingForce] = useState(false);

	const state = describeGitSync(sync);
	const busy = running !== null;

	/** action resolves to the sentence shown on success. */
	const run = async (
		operation: Operation,
		action: () => Promise<string>,
		summarize: (detail: string) => string,
	) => {
		if (busy) return;

		setError(null);
		setResult(null);
		setRunning(operation);
		try {
			setResult(await action());
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			setError({ summary: summarize(detail), detail });
		} finally {
			setRunning(null);
		}
	};

	const handleFetch = () =>
		run(
			"fetch",
			async () => {
				await onFetch();
				return "Fetched.";
			},
			() => "Fetch failed.",
		);

	const handlePull = () =>
		run(
			"pull",
			// The count comes back from the pull itself: it fetches first, so it
			// can bring in more than the numbers above it promised.
			async () => {
				const pulled = await onPull();
				return pulled > 0
					? `Pulled ${commits(pulled)}.`
					: "Already up to date.";
			},
			(detail) =>
				DIVERGED.test(detail)
					? "Could not pull: this branch and its upstream have diverged. Ask the agent in chat to merge or rebase."
					: "Pull failed.",
		);

	const handlePush = (force: boolean) => {
		// What push sends is what the counts above say: a push that would send
		// anything else is rejected rather than silently sending more.
		const success = state.needsPublish
			? "Branch published."
			: `Pushed ${commits(sync.ahead)}.`;

		return run(
			"push",
			async () => {
				await onPush(force);
				return success;
			},
			pushFailureSummary,
		);
	};

	const order = operationOrder(state.needsPublish, sync.upstream_gone);
	const buttons: Record<Operation, ReactNode> = {
		fetch: (
			<SyncButton
				key="fetch"
				icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}
				label="Fetch"
				runningLabel="Fetching…"
				isRunning={running === "fetch"}
				// Never touches the working tree, so it is the one action that is
				// always safe — and the repair action for stale counts.
				disabled={busy}
				onClick={handleFetch}
			/>
		),
		pull: (
			<SyncButton
				key="pull"
				icon={<ArrowDown className="h-4 w-4" aria-hidden="true" />}
				label={sync.behind > 0 ? `Pull (${sync.behind})` : "Pull"}
				runningLabel="Pulling…"
				isRunning={running === "pull"}
				disabled={busy || !state.canPull}
				onClick={handlePull}
			/>
		),
		push: (
			<SyncButton
				key="push"
				icon={<ArrowUp className="h-4 w-4" aria-hidden="true" />}
				label={pushLabel(sync, state.needsPublish, state.diverged)}
				runningLabel="Pushing…"
				isRunning={running === "push"}
				disabled={busy || !state.canPush}
				danger={state.diverged}
				onClick={() =>
					state.diverged ? setConfirmingForce(true) : handlePush(false)
				}
			/>
		),
	};

	// Not dismissible behind the force-push confirmation either: both listen for
	// Escape on document, and a key press meant for the dialog would otherwise
	// take the sheet down with it.
	return (
		<Sheet
			title="Sync"
			onClose={onClose}
			dismissible={!busy && !confirmingForce}
		>
			<div className="space-y-4 p-4">
				<div className="space-y-1">
					<p className="truncate text-sm text-th-text-primary">
						{sync.upstream || "No upstream"}
					</p>
					<p className="text-sm text-th-text-secondary">
						{describeCounts(sync, state.needsPublish)}
					</p>
					<p className="text-xs text-th-text-muted">
						{sync.last_fetch
							? `Last fetched ${formatRelativeDate(sync.last_fetch)}`
							: "Never fetched"}
					</p>
				</div>

				{/* Above the buttons: pushed below them it would sit off-screen on a
				    phone once the on-screen keyboard or a long message shows up. */}
				{error && (
					<div className="space-y-1" role="alert">
						<p className="text-sm text-th-error">{error.summary}</p>
						<GitOutput>{error.detail}</GitOutput>
					</div>
				)}

				{result && (
					<output className="block text-sm text-th-success">{result}</output>
				)}

				<div className="space-y-2">{order.map((op) => buttons[op])}</div>
			</div>

			{confirmingForce && (
				<ConfirmDialog
					title="Force push?"
					message={`Overwrites ${sync.upstream} with your local history. Commits pushed by others will be lost.`}
					confirmLabel="Force push"
					variant="danger"
					onConfirm={() => {
						setConfirmingForce(false);
						handlePush(true);
					}}
					onCancel={() => setConfirmingForce(false)}
				/>
			)}
		</Sheet>
	);
}

function SyncButton({
	icon,
	label,
	runningLabel,
	isRunning,
	disabled,
	danger,
	onClick,
}: {
	icon: ReactNode;
	label: string;
	runningLabel: string;
	isRunning: boolean;
	disabled: boolean;
	danger?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={`flex min-h-[44px] w-full items-center gap-3 rounded-lg bg-th-bg-tertiary px-4 py-2.5 text-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 ${
				danger ? "text-th-error" : "text-th-text-primary"
			}`}
		>
			{/* The gerund label already announces the state; the spinner's own
			    "Loading" would only say it twice. */}
			{isRunning ? <Spinner variant="current" srText={null} /> : icon}
			{isRunning ? runningLabel : label}
		</button>
	);
}

/**
 * Which operations the sheet offers, in the order the current state makes
 * sensible.
 *
 * An unpublished branch has nothing to pull *from*, so pull is left out rather
 * than shown disabled: a greyed button teaches the user nothing about what to
 * do next, while publishing is the whole reason they opened the sheet. When the
 * upstream is configured but its ref is gone, fetching is the more likely fix —
 * the ref is usually missing here, not missing on the remote — so it leads.
 */
function operationOrder(
	needsPublish: boolean,
	upstreamGone: boolean,
): Operation[] {
	if (!needsPublish) return ["fetch", "pull", "push"];
	return upstreamGone ? ["fetch", "push"] : ["push", "fetch"];
}

/**
 * Both rejections mean the same thing to the user — the remote moved — but only
 * after a fetch can the panel tell them whether pulling is enough. Anything else
 * gets no guessed summary; git's own message is below it either way.
 */
function pushFailureSummary(detail: string): string {
	if (STALE_LEASE.test(detail)) {
		return "Push rejected: the remote moved since your last fetch. Fetch, then try again.";
	}
	if (BEHIND_REMOTE.test(detail)) {
		return "Push rejected: the remote has commits you do not have. Fetch, then pull or force push.";
	}
	return "Push failed.";
}

/**
 * The chip's arrows in words: "↓2 ↑1" is an abbreviation for a 288px-wide row,
 * not an explanation.
 */
function describeCounts(sync: GitSync, needsPublish: boolean): string {
	if (needsPublish) {
		return sync.upstream_gone
			? `${sync.upstream} is missing here. Fetch to update it, or push to recreate it.`
			: "This branch exists only on this machine.";
	}

	const parts: string[] = [];
	if (sync.behind > 0) parts.push(`${commits(sync.behind)} to pull`);
	if (sync.ahead > 0) parts.push(`${commits(sync.ahead)} to push`);
	return parts.length > 0 ? parts.join(" · ") : "Up to date.";
}

function pushLabel(
	sync: GitSync,
	needsPublish: boolean,
	diverged: boolean,
): string {
	if (needsPublish) return "Publish branch";
	if (diverged) return "Push (force)";
	return sync.ahead > 0 ? `Push (${sync.ahead})` : "Push";
}

function commits(count: number): string {
	return `${count} ${count === 1 ? "commit" : "commits"}`;
}

export default SyncSheet;
