import { useCallback } from "react";
import { useWSStore } from "../lib/wsStore";
import type { RemoteUrlChangedNotification } from "../types/message";
import { useSubscription } from "./useSubscription";

function setRemoteUrl(remoteUrl: string) {
	useWSStore.setState({ remoteUrl });
}

/**
 * Keeps `remoteUrl` current while connected. Auth only reports the URL as of
 * the connection, and renewing the relay credentials can move the server to a
 * new subdomain mid-run — or end remote access, leaving it empty — after which
 * everything built on the old URL (port previews) would point at a dead host.
 *
 * A reset keeps what the store has, for the reason `remoteUrl` survives a
 * disconnect; the next snapshot replaces it.
 */
export function useRemoteUrlSubscription(enabled: boolean): void {
	const remoteUrlSubscribe = useWSStore((s) => s.actions.remoteUrlSubscribe);
	const remoteUrlUnsubscribe = useWSStore(
		(s) => s.actions.remoteUrlUnsubscribe,
	);

	const handleNotification = useCallback(
		(params: RemoteUrlChangedNotification) => setRemoteUrl(params.remote_url),
		[],
	);

	useSubscription<RemoteUrlChangedNotification, string>(
		remoteUrlSubscribe,
		remoteUrlUnsubscribe,
		handleNotification,
		{
			enabled,
			resubscribeOnWorktreeChange: false,
			onSubscribed: setRemoteUrl,
			onReset: () => {},
		},
	);
}
