import { useEffect, useState } from "react";
import { NodeList } from "./components";
import { Spinner } from "./components/ui";
import {
	authActions,
	selectIsAuthenticated,
	useAuthStore,
} from "./lib/authStore";
import { useWSStore } from "./lib/wsStore";

function getTokenFromUrl(): string | null {
	const params = new URLSearchParams(window.location.search);
	return params.get("token");
}

export default function App() {
	const { status, errorMessage, actions, version } = useWSStore();
	const isAuthenticated = useAuthStore(selectIsAuthenticated);
	const [tokenInput, setTokenInput] = useState("");
	const [inputError, setInputError] = useState<string | null>(null);
	const [isLoggingIn, setIsLoggingIn] = useState(false);

	// Try to get token from URL on mount
	useEffect(() => {
		const urlToken = getTokenFromUrl();
		if (urlToken) {
			setIsLoggingIn(true);
			authActions
				.login(urlToken)
				.then((success) => {
					if (success) {
						actions.connect();
					}
				})
				.finally(() => {
					setIsLoggingIn(false);
				});
			// Remove token from URL for security
			window.history.replaceState({}, "", window.location.pathname);
		}
	}, [actions]);

	// Connect when authenticated
	useEffect(() => {
		if (isAuthenticated && status === "disconnected") {
			actions.connect();
		}
	}, [isAuthenticated, status, actions]);

	const handleSubmitToken = async (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = tokenInput.trim();
		if (!trimmed) {
			setInputError("Token is required");
			return;
		}
		setInputError(null);
		setIsLoggingIn(true);
		const success = await authActions.login(trimmed);
		setIsLoggingIn(false);
		if (success) {
			actions.connect();
		} else {
			setInputError("Invalid token");
		}
	};

	// Show token input if not authenticated
	if (!isAuthenticated) {
		return (
			<div className="flex min-h-dvh items-center justify-center bg-th-bg-primary p-4">
				<div className="w-full max-w-sm">
					<h1 className="text-center text-2xl font-bold text-th-text-primary">
						Pockode Cluster
					</h1>
					<p className="mt-2 text-center text-sm text-th-text-secondary">
						Enter your authentication token to continue
					</p>

					<form onSubmit={handleSubmitToken} className="mt-8">
						<label
							htmlFor="token"
							className="mb-1 block text-sm text-th-text-secondary"
						>
							Token
						</label>
						<input
							id="token"
							type="password"
							value={tokenInput}
							onChange={(e) => setTokenInput(e.target.value)}
							placeholder="Enter your token"
							className="min-h-[44px] w-full rounded-lg border border-th-border bg-th-bg-secondary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-border-focus focus:outline-none"
							autoFocus
							disabled={isLoggingIn}
						/>
						{inputError && (
							<p className="mt-2 text-sm text-th-error">{inputError}</p>
						)}
						<button
							type="submit"
							disabled={isLoggingIn}
							className="mt-4 min-h-[44px] w-full rounded-lg bg-th-accent py-2 text-sm font-medium text-th-accent-text hover:bg-th-accent-hover disabled:opacity-50"
						>
							{isLoggingIn ? "Connecting..." : "Connect"}
						</button>
					</form>
				</div>
			</div>
		);
	}

	// Connecting state
	if (status === "connecting" || status === "reconnecting") {
		return (
			<div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-th-bg-primary">
				<Spinner size="h-8 w-8" />
				<p className="text-sm text-th-text-secondary">
					{status === "reconnecting" ? "Reconnecting..." : "Connecting..."}
				</p>
			</div>
		);
	}

	// Auth failed state
	if (status === "auth_failed") {
		return (
			<div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-th-bg-primary p-4 text-center">
				<div className="flex h-16 w-16 items-center justify-center rounded-full bg-th-error/10 text-th-error">
					<svg
						className="h-8 w-8"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
						/>
					</svg>
				</div>
				<h2 className="text-lg font-semibold text-th-text-primary">
					Authentication Failed
				</h2>
				<p className="text-sm text-th-text-secondary">
					{errorMessage || "Invalid token"}
				</p>
				<button
					type="button"
					onClick={() => {
						actions.disconnect();
						void authActions.logout();
						setTokenInput("");
					}}
					className="mt-4 min-h-[44px] rounded-lg bg-th-accent px-4 py-2 text-sm font-medium text-th-accent-text hover:bg-th-accent-hover"
				>
					Try Again
				</button>
			</div>
		);
	}

	// Error state
	if (status === "error") {
		return (
			<div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-th-bg-primary p-4 text-center">
				<div className="flex h-16 w-16 items-center justify-center rounded-full bg-th-error/10 text-th-error">
					<svg
						className="h-8 w-8"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
						/>
					</svg>
				</div>
				<h2 className="text-lg font-semibold text-th-text-primary">
					Connection Error
				</h2>
				<p className="text-sm text-th-text-secondary">
					{errorMessage || "Failed to connect to server"}
				</p>
				<button
					type="button"
					onClick={() => actions.connect()}
					className="mt-4 min-h-[44px] rounded-lg bg-th-accent px-4 py-2 text-sm font-medium text-th-accent-text hover:bg-th-accent-hover"
				>
					Retry
				</button>
			</div>
		);
	}

	// Connected - show node list
	return (
		<div className="flex min-h-dvh flex-col bg-th-bg-primary">
			{/* Version indicator (development only) */}
			{version && (
				<div className="fixed bottom-2 right-2 text-xs text-th-text-muted">
					v{version}
				</div>
			)}
			<NodeList />
		</div>
	);
}
