import { ReconnectBanner as Banner } from "@pockode/shared";
import { useWSStore } from "../lib/wsStore";

/**
 * Connects the shared banner to this project's ws store.
 *
 * The escalation threshold and the copy live in `@pockode/shared` because web's
 * banner is the same one; only the store it reads differs, which is all this
 * wrapper is.
 */
export function ReconnectBanner() {
	const { status, reconnectAttempts, actions } = useWSStore();

	if (status !== "reconnecting") {
		return null;
	}

	return (
		<Banner
			attempts={reconnectAttempts}
			onRetryNow={() => actions.retryNow()}
		/>
	);
}
