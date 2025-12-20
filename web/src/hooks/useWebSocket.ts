import { useEffect, useSyncExternalStore } from "react";
import { type ConnectionStatus, wsStore } from "../lib/wsStore";
import type { WSClientMessage, WSServerMessage } from "../types/message";

interface UseWebSocketOptions {
	onMessage: (message: WSServerMessage) => void;
}

interface UseWebSocketReturn {
	status: ConnectionStatus;
	send: (message: WSClientMessage) => void;
	disconnect: () => void;
}

export type { ConnectionStatus };

export function useWebSocket(options: UseWebSocketOptions): UseWebSocketReturn {
	const { onMessage } = options;

	// Subscribe to connection status using useSyncExternalStore
	const status = useSyncExternalStore(
		wsStore.subscribeStatus,
		wsStore.getStatusSnapshot,
		wsStore.getStatusSnapshot, // SSR snapshot (same as client)
	);

	// Subscribe to messages
	useEffect(() => {
		return wsStore.subscribeMessage(onMessage);
	}, [onMessage]);

	// Connect on mount (only once per app lifecycle)
	useEffect(() => {
		if (wsStore.status === "disconnected") {
			wsStore.connect();
		}
	}, []);

	return {
		status,
		send: wsStore.send,
		disconnect: wsStore.disconnect,
	};
}
