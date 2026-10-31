import { ReconnectBanner as Banner } from "@pockode/shared";
import { useWSStore, wsActions } from "../../lib/wsStore";

/**
 * Connects the shared banner to this project's ws store.
 *
 * The escalation threshold and the copy live in `@pockode/shared` because
 * web-cluster's banner is the same one; only the store it reads differs, which
 * is all this wrapper is.
 */
function ReconnectBanner() {
	const status = useWSStore((state) => state.status);
	const attempts = useWSStore((state) => state.reconnectAttempts);
	const restartRequestedAt = useWSStore((state) => state.restartRequestedAt);

	if (status !== "reconnecting") {
		return null;
	}

	return (
		<Banner
			attempts={attempts}
			onRetryNow={() => wsActions.retryNow()}
			restarting={
				restartRequestedAt === null
					? null
					: { since: restartRequestedAt, subject: "Pockode" }
			}
		/>
	);
}

export default ReconnectBanner;
