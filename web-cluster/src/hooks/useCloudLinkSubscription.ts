import {
	type CloudLinkFlow,
	type CloudLinkStatus,
	isCloudLinkUnavailable,
	newerFlow,
} from "@pockode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWSStore } from "../lib/wsStore";

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
	 * The last status read, kept through a read that failed since and while
	 * the connection is down: what is already open goes on naming the machine
	 * and the cloud.
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
 * The flows this page started. Outlives the component, as the page does, so
 * the header going away and coming back — App's unreachable screen replaces
 * it — does not turn the user's own flow into one "started earlier"; a
 * reload is a new page and starts empty. Ids only, never a code or a link.
 */
const startedByThisPage = new Set<string>();

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Follows `cloud_link.subscribe` for as long as the caller is mounted, and
 * keeps one copy of the latest flow fed by it and by the replies of `start`
 * and `cancel` (docs/cloud-link-ui.md, "Which flow it shows" — the same rules
 * as the web client's hook of the same name).
 *
 * The subscription dies with the connection, so every connect subscribes
 * again, and the snapshot that answers replaces the copy outright: revisions
 * restart with the process. Coming back to the tab subscribes again as well,
 * for what the relay does not watch.
 */
export function useCloudLinkSubscription(): CloudLinkSubscription {
	const subscribe = useWSStore((s) => s.actions.cloudLinkSubscribe);
	const unsubscribe = useWSStore((s) => s.actions.cloudLinkUnsubscribe);
	const connected = useWSStore((s) => s.status === "connected");

	const [read, setRead] = useState<CloudLinkRead>({ kind: "reading" });
	const [status, setStatus] = useState<CloudLinkStatus>();
	const [flow, setFlow] = useState<CloudLinkFlow | null>(null);
	// Bumped when startedByThisPage grows, which React cannot see.
	const [, setStartedCount] = useState(startedByThisPage.size);
	// The latest subscribe this hook sent; an older one's reply or
	// notifications are dropped, and its subscription closed.
	const attempt = useRef(0);
	const subscriptionId = useRef<string | null>(null);

	const close = useCallback(() => {
		attempt.current++;
		const id = subscriptionId.current;
		subscriptionId.current = null;
		if (id !== null) void unsubscribe(id);
	}, [unsubscribe]);

	const resubscribe = useCallback(() => {
		close();
		const mine = attempt.current;
		const apply = (next: CloudLinkStatus) => {
			setRead({ kind: "status", status: next });
			setStatus(next);
			setFlow((held) => newerFlow(held, next.flow));
		};
		// A change can be notified before the reply arrives (the server reads
		// the snapshot after registering). Applied then, it would be compared
		// with a copy from before the snapshot — perhaps another process's —
		// and then overwritten by the older snapshot; held, it is applied on
		// top of the snapshot in order, as web's useSubscription does.
		let early: CloudLinkStatus[] | null = [];
		subscribe((params) => {
			if (mine !== attempt.current) return;
			if (early) early.push(params.status);
			else apply(params.status);
		}).then(
			(result) => {
				if (mine !== attempt.current) {
					void unsubscribe(result.id);
					return;
				}
				subscriptionId.current = result.id;
				setRead({ kind: "status", status: result.status });
				setStatus(result.status);
				setFlow(result.status.flow ?? null);
				const held = early;
				early = null;
				for (const next of held ?? []) apply(next);
			},
			(err) => {
				if (mine !== attempt.current) return;
				// A drop that took the request with it is the reconnect's to tell;
				// what is shown stays until the snapshot after it.
				if (useWSStore.getState().status !== "connected") return;
				setRead(
					isCloudLinkUnavailable(err)
						? { kind: "unavailable" }
						: { kind: "failed", error: errorMessage(err) },
				);
			},
		);
	}, [close, subscribe, unsubscribe]);

	useEffect(() => {
		if (!connected) return;
		resubscribe();
		const onVisible = () => {
			if (document.visibilityState === "visible") resubscribe();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			document.removeEventListener("visibilitychange", onVisible);
			close();
		};
	}, [connected, resubscribe, close]);

	const applyFlow = useCallback(
		(incoming: CloudLinkFlow, startedHere = false) => {
			if (startedHere) {
				startedByThisPage.add(incoming.id);
				setStartedCount(startedByThisPage.size);
			}
			setFlow((held) => newerFlow(held, incoming));
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
			resubscribe();
		}, [resubscribe]),
	};
}
