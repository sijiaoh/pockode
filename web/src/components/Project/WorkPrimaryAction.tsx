import { ConfirmDialog } from "@pockode/shared";
import type { LucideIcon } from "lucide-react";
import { Loader2, Play, RotateCcw, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Activity } from "../../lib/activity";
import { useWSStore } from "../../lib/wsStore";
import type { WorkListItem, WorkStatus } from "../../types/work";

/**
 * The one thing a work row offers to do to it, decided by `status` and never by
 * `activity` (docs/lifecycle-ui.md §3).
 *
 * A button that appears and disappears as turns settle is a button the user
 * cannot aim at, so nothing here reads what the agent happens to be doing —
 * that is the confirmation's business, below, by which point the user has
 * already aimed.
 */
export type WorkAction = "start" | "restart" | "stop" | "reopen";

function primaryAction(status: WorkStatus): WorkAction {
	switch (status) {
		case "open":
			return "start";
		case "active":
			return "stop";
		case "stopped":
			return "restart";
		case "closed":
			return "reopen";
	}
}

/** Present tense, because it is what the button does, not what happened. */
export const ACTION_LABEL: Record<WorkAction, string> = {
	start: "Start",
	restart: "Restart",
	stop: "Stop",
	reopen: "Reopen",
};

export const ACTION_ICON: Record<WorkAction, LucideIcon> = {
	start: Play,
	restart: RotateCcw,
	stop: Square,
	reopen: RotateCcw,
};

/**
 * What stopping this work would cost the user, or null when it costs nothing.
 *
 * Only two things are lost by stopping, and both are invisible from the button:
 * a turn parked on background tasks ends with them, and a story's subtasks have
 * their own sessions that Stop does not reach. Everything else stops with
 * Restart one tap away, and a dialog in front of that is a dialog the user
 * learns to dismiss without reading.
 *
 * Background comes first: the tasks are gone the moment the turn ends, while
 * the subtasks the second case names go on running.
 */
function stopConfirmMessage(
	activity: Activity,
	activeChildCount: number,
): string | null {
	if (activity === "background") {
		return "Stop and end the current turn? Its background tasks will be lost.";
	}
	if (activeChildCount > 0) {
		return activeChildCount === 1
			? "Stop this story? Its 1 active subtask keeps running."
			: `Stop this story? Its ${activeChildCount} active subtasks keep running.`;
	}
	return null;
}

/** How many of a work's children the engine is still driving. */
export function countActiveChildren(children: WorkListItem[]): number {
	return children.filter((child) => child.status === "active").length;
}

/** The part of a work a command needs: what to do to it, and what that costs. */
export type CommandableWork = Pick<WorkListItem, "id" | "status" | "activity">;

/**
 * The work's primary command, from the button being pressed to the command
 * being sent.
 *
 * Both surfaces that offer one — the icon-only button on a row and the detail
 * page's action bar — run through here, so the button table, the confirmation
 * and the in-flight guard exist once. They differ only in how wide the button
 * is allowed to be.
 */
export function useWorkCommand(
	work: CommandableWork,
	activeChildCount: number,
) {
	const action = primaryAction(work.status);
	const { run, busy, error, clearError } = useWorkAction(work.id, action);
	const [confirm, setConfirm] = useState<string | null>(null);

	// A confirmation belongs to the action that raised it. The work can leave
	// `active` while the dialog is open — the engine stops it, an agent closes
	// it — and `run` follows the status, so a dialog kept across that change
	// would start the work when the user pressed the button labelled Stop.
	useEffect(() => {
		if (action !== "stop") setConfirm(null);
	}, [action]);

	const activate = useCallback(() => {
		// The confirmation may read the activity, unlike the button: by now the
		// user has aimed, and what they are about to lose depends on what is
		// happening right now.
		const message =
			action === "stop"
				? stopConfirmMessage(work.activity, activeChildCount)
				: null;
		if (message) {
			setConfirm(message);
			return;
		}
		void run();
	}, [action, work.activity, activeChildCount, run]);

	const confirmed = useCallback(() => {
		setConfirm(null);
		void run();
	}, [run]);

	const cancel = useCallback(() => setConfirm(null), []);

	return {
		action,
		busy,
		error,
		clearError,
		activate,
		confirm,
		confirmed,
		cancel,
	};
}

/** The dialog Stop raises when it would cost something. */
export function StopConfirm({
	message,
	onConfirm,
	onCancel,
}: {
	message: string;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<ConfirmDialog
			title="Stop"
			message={message}
			confirmLabel="Stop"
			variant="danger"
			onConfirm={onConfirm}
			onCancel={onCancel}
		/>
	);
}

interface Props {
	work: CommandableWork;
	/** How many of its children are still active; 0 for a task. */
	activeChildCount?: number;
	/** A row has no room for a label; a story's meta line has. */
	iconOnly?: boolean;
}

/**
 * The row's primary action: one button, whichever of the four the status calls
 * for. The detail page writes its own, wider, one — it sits beside Open Chat and
 * Delete there — from the same hook.
 */
export default function WorkPrimaryAction({
	work,
	activeChildCount = 0,
	iconOnly,
}: Props) {
	const { action, busy, error, activate, confirm, confirmed, cancel } =
		useWorkCommand(work, activeChildCount);

	const handleClick = useCallback(
		(e: React.MouseEvent) => {
			// The row around this button opens the work; the command is not that.
			e.stopPropagation();
			activate();
		},
		[activate],
	);

	const Icon = ACTION_ICON[action];
	const danger = action === "stop";

	return (
		<>
			{iconOnly ? (
				<button
					type="button"
					onClick={handleClick}
					disabled={busy}
					className={`flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center disabled:opacity-50 ${error || danger ? "text-th-error" : "text-th-accent"}`}
					aria-label={error ?? ACTION_LABEL[action]}
				>
					{busy ? (
						<Loader2 className="size-3.5 animate-spin" />
					) : (
						<Icon className="size-3.5" />
					)}
				</button>
			) : (
				<button
					type="button"
					onClick={handleClick}
					disabled={busy}
					className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs disabled:opacity-50 ${error || danger ? "border border-th-error bg-th-error/10" : "border border-th-accent bg-th-accent/10"} text-th-text-primary`}
					aria-label={error ?? undefined}
				>
					{busy ? (
						<Loader2 className="size-3 animate-spin" />
					) : (
						<Icon className="size-3" />
					)}
					{error ? "Error" : ACTION_LABEL[action]}
				</button>
			)}
			{confirm && (
				<StopConfirm
					message={confirm}
					onConfirm={confirmed}
					onCancel={cancel}
				/>
			)}
		</>
	);
}

/**
 * Running one of the four commands, with the in-flight guard and the error the
 * user has to be told about.
 *
 * The guard is a ref and not the `busy` state: a second click arrives before
 * React has re-rendered the disabled button, and a work started twice is a
 * second session. The failure is shown on the button rather than swallowed —
 * these are commands whose whole effect is elsewhere, so a silent one leaves
 * the user watching a row that never changes.
 */
function useWorkAction(workId: string, action: WorkAction) {
	const startWork = useWSStore((s) => s.actions.startWork);
	const stopWork = useWSStore((s) => s.actions.stopWork);
	const reopenWork = useWSStore((s) => s.actions.reopenWork);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inFlight = useRef(false);

	const run = useCallback(async () => {
		if (inFlight.current) return;
		inFlight.current = true;
		setError(null);
		setBusy(true);
		try {
			if (action === "stop") await stopWork(workId);
			else if (action === "reopen") await reopenWork(workId);
			else await startWork(workId);
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: `Failed to ${ACTION_LABEL[action].toLowerCase()}`,
			);
		} finally {
			inFlight.current = false;
			setBusy(false);
		}
	}, [action, workId, startWork, stopWork, reopenWork]);

	const clearError = useCallback(() => setError(null), []);

	return { run, busy, error, clearError };
}
