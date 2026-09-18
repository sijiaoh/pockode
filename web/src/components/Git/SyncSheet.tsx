import { ConfirmDialog } from "@pockode/shared";
import { ArrowDown, ArrowUp, RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useGitSyncRunner } from "../../hooks/useGitSync";
import { type SyncOperation, useSyncRun } from "../../lib/gitSyncStore";
import { useWorktreeStore } from "../../lib/worktreeStore";
import { describeGitSync, type GitSync } from "../../types/git";
import { commits } from "../../utils/gitSyncMessages";
import { formatRelativeDate } from "../../utils/relativeTime";
import { Sheet, Spinner } from "../ui";
import GitOutput from "./GitOutput";

interface Props {
	sync: GitSync;
	onClose: () => void;
}

/**
 * Fetch, pull and push — the only operations in the panel that wait on a machine
 * other than this one, and so the only ones with no bound on how long they take.
 *
 * The sheet stays open after one succeeds: over a slow relay link, a sheet that
 * closes by itself leaves the user unsure whether anything happened at all. It
 * can be closed while one runs, though — the run belongs to the sync store, not
 * to this sheet, so reopening shows the same run rather than a blank panel.
 */
function SyncSheet({ sync, onClose }: Props) {
	const worktree = useWorktreeStore((s) => s.current);
	const { running, outcome } = useSyncRun(worktree);
	const { startFetch, startPull, startPush } = useGitSyncRunner();
	const [confirmingForce, setConfirmingForce] = useState(false);

	const state = describeGitSync(sync);
	const busy = running !== null;

	const order = operationOrder(state.needsPublish, sync.upstream_gone);
	const buttons: Record<SyncOperation, ReactNode> = {
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
				onClick={startFetch}
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
				onClick={startPull}
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
					state.diverged ? setConfirmingForce(true) : startPush(sync, false)
				}
			/>
		),
	};

	// Not dismissible behind the force-push confirmation: both it and the sheet
	// listen for Escape on document, and a key press meant for the dialog would
	// otherwise take the sheet down with it.
	return (
		<Sheet title="Sync" onClose={onClose} dismissible={!confirmingForce}>
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
				{outcome?.kind === "error" && (
					<div className="space-y-1" role="alert">
						<p className="text-sm text-th-error">{outcome.summary}</p>
						{/* Absent when the server refused before running git: there is
						    no output to quote, only the sentence above. */}
						{outcome.detail && <GitOutput>{outcome.detail}</GitOutput>}
					</div>
				)}

				{outcome?.kind === "success" && (
					<output className="block text-sm text-th-success">
						{outcome.message}
					</output>
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
						startPush(sync, true);
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
): SyncOperation[] {
	if (!needsPublish) return ["fetch", "pull", "push"];
	return upstreamGone ? ["fetch", "push"] : ["push", "fetch"];
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

export default SyncSheet;
