import { useEffect } from "react";
import { useAgentOptionsStore } from "../lib/agentOptionsStore";
import { useWSStore } from "../lib/wsStore";

/**
 * Loads the per-agent model and effort lists once the connection is up, and
 * again after a reconnect — the server may have been upgraded with different
 * lists. Not a subscription: the lists are compiled into the server and cannot
 * change while it runs.
 */
export function useAgentOptions(enabled: boolean) {
	const status = useWSStore((s) => s.status);
	const listModels = useWSStore((s) => s.actions.listModels);
	const listEfforts = useWSStore((s) => s.actions.listEfforts);

	useEffect(() => {
		if (!enabled || status !== "connected") return;

		let cancelled = false;
		const { setModels, setEfforts, setError } = useAgentOptionsStore.getState();

		// Settled rather than all: one list arriving is worth keeping even if the
		// other failed, and the selector can offer Auto for whichever is missing.
		Promise.allSettled([listModels(), listEfforts()]).then(
			([models, efforts]) => {
				if (cancelled) return;
				if (models.status === "fulfilled") setModels(models.value);
				if (efforts.status === "fulfilled") setEfforts(efforts.value);

				// One error line for both, because they are one fetch as far as the
				// panel showing it is concerned. The first reason wins; a second copy
				// of "connection closed" teaches nobody anything.
				for (const result of [models, efforts]) {
					if (result.status === "rejected") {
						const reason: unknown = result.reason;
						setError(
							reason instanceof Error && reason.message
								? reason.message
								: "Failed to load the engine options",
						);
						break;
					}
				}
			},
		);

		return () => {
			cancelled = true;
		};
	}, [enabled, status, listModels, listEfforts]);
}
