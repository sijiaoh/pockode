import { useCallback, useEffect, useState } from "react";
import { isCloudLinkUnavailable } from "../lib/rpc";
import { useWSStore } from "../lib/wsStore";
import type {
	CloudLinkChangedNotification,
	CloudLinkFlow,
	CloudLinkStatus,
} from "../types/cloudLink";
import { errorMessage } from "../utils/errorMessage";
import { useSubscription } from "./useSubscription";

/** What reading the link status came to. */
export type CloudLinkRead =
	| { kind: "reading" }
	| { kind: "status"; status: CloudLinkStatus }
	/** The process cannot keep a cloud link at all (`-32013`). */
	| { kind: "unavailable" }
	| { kind: "failed"; error: string };

export interface CloudLinkSubscription {
	read: CloudLinkRead;
	/**
	 * The last status read, kept through a read that failed since: what a
	 * sheet already open goes on naming — the machine, the cloud.
	 */
	status: CloudLinkStatus | undefined;
	/**
	 * The latest flow this page knows of: the running one, or the last to
	 * end. Null when the process has had none — after a restart, too.
	 */
	flow: CloudLinkFlow | null;
	/** Whether a `start` call from this page returned the flow with this id. */
	startedHere: (flowId: string) => boolean;
	/** A `start` or `cancel` reply, kept if it is newer than the copy held. */
	applyFlow: (flow: CloudLinkFlow, startedHere?: boolean) => void;
	/** A `start` answered `-32013`. */
	markUnavailable: () => void;
	retry: () => void;
}

/**
 * The flows this page started. Outlives the section, as the page does, so
 * leaving Settings and coming back does not turn the user's own flow into one
 * "started earlier"; a reload is a new page and starts empty. Ids only, never
 * a code or a link.
 */
const startedByThisPage = new Set<string>();

/**
 * Of two copies from the same process, the one with the higher revision: the
 * process's one counter is shared by all its flows, so that is the newer news
 * whatever the ids (docs/code/cloud-account.md#the-status).
 */
function newer(
	held: CloudLinkFlow | null,
	incoming: CloudLinkFlow | undefined,
): CloudLinkFlow | null {
	if (!incoming) return held;
	if (!held || incoming.revision > held.revision) return incoming;
	return held;
}

/**
 * Follows `cloud_link.subscribe` for the Cloud section, and keeps one copy of
 * the latest flow fed by it and by the replies of `start` and `cancel`
 * (docs/cloud-link-ui.md, "Which flow it shows").
 *
 * No global store: nothing outside the section reads the link, and the flow
 * comes back with the snapshot. A reset keeps what was read — the card goes on
 * showing it, disabled, while the socket is down — and a new snapshot
 * replaces it outright, the flow included: revisions restart with the
 * process. What the relay does not watch is caught by subscribing again
 * whenever the page comes back into view.
 */
export function useCloudLinkSubscription(): CloudLinkSubscription {
	const cloudLinkSubscribe = useWSStore((s) => s.actions.cloudLinkSubscribe);
	const cloudLinkUnsubscribe = useWSStore(
		(s) => s.actions.cloudLinkUnsubscribe,
	);
	const isConnected = useWSStore((s) => s.status === "connected");

	const [read, setRead] = useState<CloudLinkRead>({ kind: "reading" });
	const [status, setStatus] = useState<CloudLinkStatus>();
	const [flow, setFlow] = useState<CloudLinkFlow | null>(null);
	// Bumped when startedByThisPage grows, which React cannot see.
	const [, setStartedCount] = useState(startedByThisPage.size);

	const onSnapshot = useCallback((next: CloudLinkStatus) => {
		setRead({ kind: "status", status: next });
		setStatus(next);
		setFlow(next.flow ?? null);
	}, []);

	const onChanged = useCallback((params: CloudLinkChangedNotification) => {
		setRead({ kind: "status", status: params.status });
		setStatus(params.status);
		setFlow((held) => newer(held, params.status.flow));
	}, []);

	const { refresh } = useSubscription<
		CloudLinkChangedNotification,
		CloudLinkStatus
	>(cloudLinkSubscribe, cloudLinkUnsubscribe, onChanged, {
		// The status is the process's, not a worktree's.
		resubscribeOnWorktreeChange: false,
		onSubscribed: onSnapshot,
		onReset: () => {},
		onError: (err) =>
			setRead(
				isCloudLinkUnavailable(err)
					? { kind: "unavailable" }
					: { kind: "failed", error: errorMessage(err) },
			),
	});

	useEffect(() => {
		if (!isConnected) return;
		const onVisible = () => {
			if (document.visibilityState === "visible") void refresh();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [isConnected, refresh]);

	const applyFlow = useCallback(
		(incoming: CloudLinkFlow, startedHere = false) => {
			if (startedHere) {
				startedByThisPage.add(incoming.id);
				setStartedCount(startedByThisPage.size);
			}
			setFlow((held) => newer(held, incoming));
		},
		[],
	);

	return {
		read,
		status,
		flow,
		startedHere: useCallback((id: string) => startedByThisPage.has(id), []),
		applyFlow,
		markUnavailable: useCallback(() => setRead({ kind: "unavailable" }), []),
		retry: useCallback(() => {
			setRead({ kind: "reading" });
			void refresh();
		}, [refresh]),
	};
}
