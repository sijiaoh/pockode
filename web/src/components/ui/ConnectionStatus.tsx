import { Loader2, RefreshCw, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useWSStore } from "../../lib/wsStore";

const STABLE_DELAY_MS = 1000;

/**
 * Displays WebSocket connection status in the header.
 * - Connected: hidden (don't distract users during normal operation)
 * - Connecting/Disconnected: spinning loader with optional text
 * - Error: warning icon with retry button
 *
 * Uses debouncing to prevent flicker during reconnection attempts.
 */
function ConnectionStatus() {
	const status = useWSStore((state) => state.status);
	const [visible, setVisible] = useState(status !== "connected");

	useEffect(() => {
		if (status !== "connected") {
			setVisible(true);
			return;
		}

		// Delay hiding to prevent flicker during reconnection
		const timer = setTimeout(() => setVisible(false), STABLE_DELAY_MS);
		return () => clearTimeout(timer);
	}, [status]);

	if (!visible) {
		return null;
	}

	if (status === "error" || status === "auth_failed") {
		return (
			<button
				type="button"
				onClick={() => window.location.reload()}
				className="flex items-center gap-1 rounded-md bg-red-500/10 px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-500/20 active:bg-red-500/25"
				aria-label="Connection failed. Click to retry"
			>
				<WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
				<span className="hidden sm:inline">Offline</span>
				<RefreshCw className="h-3 w-3" aria-hidden="true" />
			</button>
		);
	}

	// connecting or disconnected - show unified connecting state
	return (
		// biome-ignore lint/a11y/useSemanticElements: status indicator is not a form output
		<div
			className="flex items-center gap-1 text-xs text-th-text-muted"
			role="status"
			aria-label="Connecting to server"
		>
			<Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
			<span className="hidden sm:inline">Connecting</span>
		</div>
	);
}

export default ConnectionStatus;
