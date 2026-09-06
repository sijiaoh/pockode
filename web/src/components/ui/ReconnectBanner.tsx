import { useWSStore, wsActions } from "../../lib/wsStore";

/**
 * Attempts after which the banner stops implying "any second now".
 *
 * The backoff reaches this on the fifth drop, about 15 s in (1+2+4+8 s of
 * waiting). By then the cause is more likely a real outage than a blip, and the
 * next automatic attempt is far enough off that offering to skip it earns its
 * screen space.
 */
const OUTAGE_AFTER_ATTEMPTS = 4;

/**
 * Shown while the WebSocket is down and reconnecting.
 *
 * Reconnection never gives up, so this banner is the only thing that tells a
 * short blip apart from an outage; without the escalation an hour-long outage
 * looks exactly like a one-second one.
 */
function ReconnectBanner() {
	const status = useWSStore((state) => state.status);
	const attempts = useWSStore((state) => state.reconnectAttempts);

	if (status !== "reconnecting") {
		return null;
	}

	const outage = attempts > OUTAGE_AFTER_ATTEMPTS;

	return (
		// biome-ignore lint/a11y/useSemanticElements: status banner is not a form output
		<div
			className="flex items-center justify-center gap-2 bg-th-accent/20 px-4 py-1 text-sm text-th-text-muted"
			role="status"
		>
			<span className="inline-block h-2 w-2 animate-pulse rounded-full bg-th-accent" />
			{outage ? "Can't reach the server. Still trying..." : "Reconnecting..."}
			{outage && (
				<button
					type="button"
					onClick={() => wsActions.retryNow()}
					className="underline underline-offset-2 hover:text-th-text-primary"
				>
					Retry now
				</button>
			)}
		</div>
	);
}

export default ReconnectBanner;
