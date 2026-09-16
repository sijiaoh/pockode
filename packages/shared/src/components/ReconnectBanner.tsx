/**
 * Attempts after which the banner stops implying "any second now".
 *
 * Both clients double a 1 s delay up to a 30 s ceiling (web jitters it by a
 * fifth), so this is reached on the fifth drop, roughly 15 s in (1+2+4+8 s of
 * waiting). By then the cause is more likely a real outage than a blip, and the
 * next automatic attempt is far enough off that offering to skip it earns its
 * screen space.
 */
const OUTAGE_AFTER_ATTEMPTS = 4;

export interface ReconnectBannerProps {
	/** Reconnect attempts since the last connection that succeeded. */
	attempts: number;
	onRetryNow: () => void;
}

/**
 * Shown while a WebSocket is down and reconnecting.
 *
 * Presentational only: *whether* the connection is down is the caller's
 * question, and the two projects' stores answer it differently enough that a
 * shared component reading either one would have to know about both. What is
 * genuinely the same is this escalation — reconnection never gives up, so it is
 * the only thing that tells a short blip apart from an outage; without it an
 * hour-long outage looks exactly like a one-second one.
 */
export function ReconnectBanner({
	attempts,
	onRetryNow,
}: ReconnectBannerProps) {
	const outage = attempts > OUTAGE_AFTER_ATTEMPTS;

	return (
		// biome-ignore lint/a11y/useSemanticElements: status banner is not a form output
		<div
			className="flex items-center justify-center gap-2 bg-th-accent/20 px-4 py-1 text-sm text-th-text-primary"
			role="status"
		>
			<span className="inline-block h-2 w-2 animate-pulse rounded-full bg-th-accent" />
			{outage ? "Can't reach the server. Still trying..." : "Reconnecting..."}
			{outage && (
				<button
					type="button"
					onClick={onRetryNow}
					className="inline-flex min-h-9 items-center rounded px-2 underline underline-offset-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11 hover:opacity-80"
				>
					Retry now
				</button>
			)}
		</div>
	);
}
