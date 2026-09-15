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
		<div className={`text-xs text-th-error ${className}`} role="alert">
			<p>Couldn't load settings: {error}</p>
			{refresh && (
				<button
					type="button"
					onClick={() => refresh()}
					className="mt-1 inline-flex min-h-9 items-center rounded px-2 underline pointer-coarse:min-h-11 pointer-coarse:min-w-11 hover:text-th-text-primary"
				>
					Retry
				</button>
			)}
		</div>
	);
}
