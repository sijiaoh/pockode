import { useEffect } from "react";
import { useAgentModelStore } from "../lib/agentModelStore";
import { useWSStore } from "../lib/wsStore";

/**
 * Loads the per-agent model lists once the connection is up, and again after a
 * reconnect — the server may have been upgraded with a different list. Not a
 * subscription: the lists are compiled into the server and cannot change while
 * it runs.
 */
export function useAgentModels(enabled: boolean) {
	const status = useWSStore((s) => s.status);
	const listModels = useWSStore((s) => s.actions.listModels);

	useEffect(() => {
		if (!enabled || status !== "connected") return;

		let cancelled = false;
		const { setModels, setError } = useAgentModelStore.getState();

		listModels()
			.then((models) => {
				if (!cancelled) setModels(models);
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				setError(
					error instanceof Error && error.message
						? error.message
						: "Failed to load the model list",
				);
			});

		return () => {
			cancelled = true;
		};
	}, [enabled, status, listModels]);
}
