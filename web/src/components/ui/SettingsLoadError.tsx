import { useGlobalSettingsStatus } from "../../hooks/useGlobalSettingsStatus";

/**
 * What the controls that wait on the global settings say when the snapshot is
 * not coming. Nothing about the connection: this failure happens on a socket
 * that is still open, and the one case where the connection is at fault is
 * `ReconnectBanner`'s to explain — it keeps the last snapshot on screen, so the
 * controls stay usable and this line never shows.
 *
 * The server's own reason goes out with it, the way every other failure in these
 * panels reports one: the people reading this are the ones who can act on it, and
 * a fixed sentence would be the last thing left in this flow that knows something
 * and says something vaguer.
 */
interface Props {
	/** Spacing the host section wants around the line; it owns the layout. */
	className?: string;
}

export default function SettingsLoadError({ className = "" }: Props) {
	const { error, refresh } = useGlobalSettingsStatus();
	if (!error) return null;

	return (
		<p className={`text-xs text-th-error ${className}`} role="alert">
			Couldn't load settings: {error}{" "}
			{refresh && (
				<button
					type="button"
					onClick={() => refresh()}
					className="underline hover:text-th-text-primary"
				>
					Retry
				</button>
			)}
		</p>
	);
}
