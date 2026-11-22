import { ConfirmDialog } from "@pockode/shared";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { AUTO_ID, getOptionLabel } from "../lib/agentOptions";
import {
	useEffortsForAgent,
	useModelsForAgent,
} from "../lib/agentOptionsStore";
import { getAgentLabel, hasPermissionReviewer } from "../lib/agentType";
import { useSettingsStore } from "../lib/settingsStore";
import type { SessionMode } from "../types/message";
import type { AgentType, PermissionReviewerEngine } from "../types/settings";

/**
 * Which choice is being confirmed: a session's own mode, or the default new
 * sessions start in. The fact stated is the same; who it applies to is not.
 */
export type ModeConfirmationTarget = "session" | "default";

interface ModeConfirmation {
	/**
	 * Resolves true once the choice may be sent. Default and YOLO are instant,
	 * as they have always been; Unattended waits on the dialog, because its
	 * description cannot carry the one surprising fact — that it is *more*
	 * permissive than YOLO (docs/unattended-mode-ui.md §2.2).
	 */
	confirm: (mode: SessionMode) => Promise<boolean>;
	/** Rendered by the caller; null while nothing is being confirmed. */
	dialog: ReactNode;
}

export function useModeConfirmation(
	target: ModeConfirmationTarget,
	agentType: AgentType,
): ModeConfirmation {
	const [open, setOpen] = useState(false);
	const pending = useRef<((ok: boolean) => void) | null>(null);
	const reviewerEngine = useReviewerEngineLabel();

	const settle = useCallback((ok: boolean) => {
		pending.current?.(ok);
		pending.current = null;
		setOpen(false);
	}, []);

	// A caller unmounting mid-question must not leave its await hanging.
	useEffect(() => () => pending.current?.(false), []);

	const confirm = useCallback((mode: SessionMode) => {
		if (mode !== "unattended") return Promise.resolve(true);
		// A second choice while one is asked replaces it: only one dialog is up.
		pending.current?.(false);
		setOpen(true);
		return new Promise<boolean>((resolve) => {
			pending.current = resolve;
		});
	}, []);

	const onCancel = useCallback(() => settle(false), [settle]);

	const dialog = open ? (
		<ConfirmDialog
			title={
				target === "session"
					? "Turn on Unattended?"
					: "Make Unattended the default?"
			}
			message={unattendedMessage(target, agentType, reviewerEngine)}
			confirmLabel={
				target === "session" ? "Turn on Unattended" : "Make default"
			}
			onConfirm={() => settle(true)}
			onCancel={onCancel}
		/>
	) : null;

	return { confirm, dialog };
}

function unattendedMessage(
	target: ModeConfirmationTarget,
	agentType: AgentType,
	reviewerEngine: string | null,
): string {
	const subject =
		target === "session" ? "The agent runs" : "New sessions' agents run";
	if (!hasPermissionReviewer(agentType)) {
		// The same definition, with nothing to trigger it: never "it's just YOLO".
		const label = getAgentLabel(agentType);
		const sessions =
			target === "session"
				? "this session never reaches"
				: `new ${label} sessions never reach`;
		return `Unattended is YOLO and more. ${subject} every command without asking, and any permission request still raised under YOLO is answered by a permission reviewer agent instead of you.

${label} never raises one under YOLO, so ${sessions} a review.`;
	}
	// The engine is left out rather than guessed while settings have not loaded.
	const engine = reviewerEngine
		? `; they run on ${reviewerEngine} (Settings › Session).`
		: ".";
	return `Unattended is YOLO and more. ${subject} every command without asking, and the few requests YOLO still stops for — like an rm whose target can't be checked, or a protected path — are answered by a permission reviewer agent instead of you.

Each answer and its reason is shown on the request. You can still answer one yourself first. Reviews use tokens${engine}`;
}

// Stable, so the selector below does not hand back a fresh object per read.
const UNSET_ENGINE: PermissionReviewerEngine = {};

/**
 * The reviewer engine, named the way the Engine field names a model and effort;
 * null until settings have loaded. What the next review runs on — always
 * Claude's, the one agent with a reviewer (`hasPermissionReviewer`).
 */
export function useReviewerEngineLabel(): string | null {
	const engine = useSettingsStore((s) =>
		s.settings
			? (s.settings.permission_reviewer?.claude ?? UNSET_ENGINE)
			: null,
	);
	const models = useModelsForAgent("claude");
	const efforts = useEffortsForAgent("claude");
	if (!engine) return null;
	const model = engine.model ?? AUTO_ID;
	const effort = engine.effort ?? AUTO_ID;
	return [
		getOptionLabel(models, model),
		effort === AUTO_ID ? null : getOptionLabel(efforts, effort),
	]
		.filter(Boolean)
		.join(" · ");
}
