import { useCallback, useRef } from "react";
import { useWorkStore, workPagingActions } from "../lib/workStore";
import { useWSStore } from "../lib/wsStore";
import type {
	WorkListChangedNotification,
	WorkListSubscribeResult,
} from "../types/work";
import { useSubscription } from "./useSubscription";

/**
 * The project list's subscription.
 *
 * What it delivers is the `Current` segment, whole and always whole
 * (docs/list-paging-ui.md §4.1). The two things that are fetched — a page of
 * the closed archive, and the rows the snapshot's group caps held back — are
 * `workPagingActions`, bound to this subscription for as long as it is open.
 */
export function useWorkSubscription(enabled: boolean) {
	const workListSubscribe = useWSStore((s) => s.actions.workListSubscribe);
	const workListUnsubscribe = useWSStore((s) => s.actions.workListUnsubscribe);

	const setWorks = useWorkStore((s) => s.setWorks);
	const updateWorks = useWorkStore((s) => s.updateWorks);
	const updateArchiveRow = useWorkStore((s) => s.updateArchiveRow);
	const removeFromArchive = useWorkStore((s) => s.removeFromArchive);
	const markArchiveStale = useWorkStore((s) => s.markArchiveStale);
	const setError = useWorkStore((s) => s.setError);
	const reset = useWorkStore((s) => s.reset);

	// `refresh` is what a page rejected as invalid params recovers by, and it is
	// only defined below — so the binding reads it through a ref.
	const refreshRef = useRef<() => void>(() => {});
	// Which subscribe call is the current one. Two can be in flight — a refresh
	// racing the mount — and they can resolve in either order, so the binding
	// goes to the one that started last rather than to the one that answered
	// last. `useSubscription` makes the same judgement about the subscription
	// itself; this is the same judgement about its id.
	const attemptRef = useRef(0);

	const subscribe = useCallback(
		async (onNotification: (params: WorkListChangedNotification) => void) => {
			const attempt = ++attemptRef.current;
			const result = await workListSubscribe(onNotification);
			if (attempt === attemptRef.current) {
				workPagingActions.bind(result.id, () => refreshRef.current());
			}
			return result;
		},
		[workListSubscribe],
	);

	const applySnapshot = useCallback(
		(initial: WorkListSubscribeResult) => {
			setWorks(initial.items, {
				stopped: initial.stopped_hidden ?? 0,
				open: initial.open_hidden ?? 0,
			});
			// A snapshot is the whole of `Current` and not one word about the
			// archive, so a work that closed while this client was away — a
			// reconnect opens a new subscription over a page fetched by the old one
			// — arrives through nothing else.
			markArchiveStale();
		},
		[setWorks, markArchiveStale],
	);

	const handleNotification = useCallback(
		(params: WorkListChangedNotification) => {
			if (params.operation === "sync") {
				setWorks(params.works, {
					stopped: params.stopped_hidden ?? 0,
					open: params.open_hidden ?? 0,
				});
				// A sync follows a dropped event, and one of the dropped ones may
				// have been a close — which this carries no trace of, since
				// `Current` holds no closed work.
				markArchiveStale();
				return;
			}
			if (params.operation === "delete") {
				updateWorks((old) => old.filter((w) => w.id !== params.workId));
				removeFromArchive(params.workId);
				return;
			}
			const row = params.work;
			// One upsert for create and update alike. An update for a row the client
			// does not hold is not noise to drop: the snapshot leaves out closed
			// work and the least recently updated of the two capped groups, and a
			// work in any of them that starts needing a person has to arrive —
			// dropping it is exactly how the attention dot would go dark on a
			// project that needs one
			// (docs/list-paging-ui.md §2.1). A row nothing draws costs a place in an
			// array.
			updateWorks((old) =>
				old.some((w) => w.id === row.id)
					? old.map((w) => (w.id === row.id ? row : w))
					: [...old, row],
			);
			// The archive is fetched and never pushed to. Two things a push may
			// still do to it, and no third: keep a row already on the page the user
			// is reading accurate, and tell a page that does not hold this closed
			// story that it was cut too early (§4.3).
			updateArchiveRow(row);
		},
		[
			setWorks,
			updateWorks,
			updateArchiveRow,
			removeFromArchive,
			markArchiveStale,
		],
	);

	const handleError = useCallback(
		(err: unknown) => {
			const message =
				err instanceof Error ? err.message : "Failed to load work items";
			setError(message);
		},
		[setError],
	);

	const handleReset = useCallback(() => {
		workPagingActions.unbind();
		reset();
	}, [reset]);

	const { refresh } = useSubscription<
		WorkListChangedNotification,
		WorkListSubscribeResult
	>(subscribe, workListUnsubscribe, handleNotification, {
		enabled,
		resubscribeOnWorktreeChange: false,
		onSubscribed: applySnapshot,
		onReset: handleReset,
		onError: handleError,
	});
	refreshRef.current = refresh;

	return { refresh };
}
