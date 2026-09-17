import { useCallback } from "react";
import { useWorkStore } from "../lib/workStore";
import { useWSStore } from "../lib/wsStore";
import type { WorkListChangedNotification, WorkListItem } from "../types/work";
import { useSubscription } from "./useSubscription";

export function useWorkSubscription(enabled: boolean) {
	const workListSubscribe = useWSStore((s) => s.actions.workListSubscribe);
	const workListUnsubscribe = useWSStore((s) => s.actions.workListUnsubscribe);

	const setWorks = useWorkStore((s) => s.setWorks);
	const updateWorks = useWorkStore((s) => s.updateWorks);
	const setError = useWorkStore((s) => s.setError);
	const reset = useWorkStore((s) => s.reset);

	const handleNotification = useCallback(
		(params: WorkListChangedNotification) => {
			if (params.operation === "sync") {
				setWorks(params.works);
				return;
			}
			if (params.operation === "delete") {
				updateWorks((old) => old.filter((w) => w.id !== params.workId));
				return;
			}
			const row = params.work;
			updateWorks((old) => {
				switch (params.operation) {
					case "create":
						// Deduplicate: subscription is registered before the initial
						// list is fetched, so a create event may arrive for an item
						// already included in the snapshot.
						if (old.some((w) => w.id === row.id)) {
							return old.map((w) => (w.id === row.id ? row : w));
						}
						return [...old, row];
					case "update":
						return old.map((w) => (w.id === row.id ? row : w));
				}
			});
		},
		[setWorks, updateWorks],
	);

	const handleError = useCallback(
		(err: unknown) => {
			const message =
				err instanceof Error ? err.message : "Failed to load work items";
			setError(message);
		},
		[setError],
	);

	const { refresh } = useSubscription<
		WorkListChangedNotification,
		WorkListItem[]
	>(workListSubscribe, workListUnsubscribe, handleNotification, {
		enabled,
		resubscribeOnWorktreeChange: false,
		onSubscribed: setWorks,
		onReset: reset,
		onError: handleError,
	});

	return { refresh };
}
