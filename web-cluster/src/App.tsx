import { Spinner } from "@pockode/shared";
import { useEffect, useState } from "react";
import { NodeList } from "./components";
import { authActions, useAuthStore } from "./lib/authStore";
import { useWSStore } from "./lib/wsStore";

/**
 * How long a connect may take before it is worth saying anything about.
 *
 * A local cluster answers well inside this, and a spinner that appears and
 * disappears inside a few frames reads as a glitch rather than as progress.
 */
const CONNECTING_SPINNER_DELAY_MS = 300;

function getTokenFromUrl(): string | null {
	const params = new URLSearchParams(window.location.search);
	return params.get("token");
}

export default function App() {
	const { status, errorMessage, actions, version } = useWSStore();
	const token = useAuthStore((state) => state.token);
	const [tokenInput, setTokenInput] = useState("");
	const [tokenVisible, setTokenVisible] = useState(false);
	const [inputError, setInputError] = useState<string | null>(null);
	const [connectingVisible, setConnectingVisible] = useState(false);

	useEffect(() => {
		if (status !== "connecting") {
			setConnectingVisible(false);
			return;
		}
		const timer = setTimeout(
			() => setConnectingVisible(true),
			CONNECTING_SPINNER_DELAY_MS,
		);
		return () => clearTimeout(timer);
	}, [status]);

	useEffect(() => {
		const urlToken = getTokenFromUrl();
		if (urlToken) {
			authActions.login(urlToken);
			// Remove token from URL for security
			window.history.replaceState({}, "", window.location.pathname);
		}
	}, []);

	useEffect(() => {
		if (token && status === "disconnected") {
			actions.connect(token);
		}
	}, [token, status, actions]);

	const handleSubmitToken = (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = tokenInput.trim();
		if (!trimmed) {
			setInputError("Auth token is required.");
			return;
		}
		setInputError(null);
		authActions.login(trimmed);
	};

	if (!token) {
		return (
			<div className="flex min-h-dvh items-center justify-center bg-th-bg-primary p-4">
				<div className="w-full max-w-sm">
					<h1 className="text-center text-2xl font-bold text-th-text-primary">
						Pockode Cluster
					</h1>
					<p className="mt-2 text-center text-sm text-th-text-secondary">
						Connect to your cluster instance.
					</p>

					<form onSubmit={handleSubmitToken} className="mt-8">
						<label
							htmlFor="token"
							className="mb-1 block text-sm text-th-text-secondary"
						>
							Auth Token
						</label>
						{/* A token is long, random and usually typed on a phone
						    keyboard; typing it blind is the worst moment in the
						    product, so it can be read back. */}
						<div className="relative">
							<input
								id="token"
								type={tokenVisible ? "text" : "password"}
								value={tokenInput}
								onChange={(e) => setTokenInput(e.target.value)}
								placeholder="Enter your token"
								className="min-h-[44px] w-full rounded-lg border border-th-border bg-th-bg-secondary py-2 pl-3 pr-16 font-mono text-sm text-th-text-primary placeholder:font-sans placeholder:text-th-text-muted focus:border-th-border-focus focus:outline-none"
								aria-describedby="token-help"
								autoCapitalize="off"
								autoCorrect="off"
								spellCheck={false}
								autoFocus
							/>
							<button
								type="button"
								onClick={() => setTokenVisible((visible) => !visible)}
								className="touch-target absolute inset-y-0 right-0 flex items-center px-3 text-xs font-medium text-th-text-secondary hover:text-th-text-primary"
							>
								{tokenVisible ? "Hide" : "Show"}
							</button>
						</div>
						{/* Described by the field rather than merely placed under it:
						    where the token comes from is the answer to the question the
						    field raises, and a reader who never sees the layout would
						    otherwise never be given it. */}
						<p id="token-help" className="mt-1 text-xs text-th-text-muted">
							The <code className="font-mono">--auth-token</code> you started
							the cluster with.
						</p>
						{inputError && (
							<p className="mt-2 text-sm text-th-error">{inputError}</p>
						)}
						<button
							type="submit"
							className="mt-4 min-h-[44px] w-full rounded-lg bg-th-accent py-2 text-sm font-medium text-th-accent-text hover:bg-th-accent-hover"
						>
							Connect
						</button>
					</form>
				</div>
			</div>
		);
	}

	if (status === "connecting") {
		return (
			<div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-th-bg-primary">
				{connectingVisible && (
					<>
						<Spinner size="h-8 w-8" />
						<p className="text-sm text-th-text-secondary">
							Connecting to cluster...
						</p>
					</>
				)}
			</div>
		);
	}

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
					Authentication failed
				</h2>
				<p className="text-sm text-th-text-secondary">
					{errorMessage || "Check the cluster token and try again."}
				</p>
				<button
					type="button"
					onClick={() => {
						actions.disconnect();
						authActions.logout();
						setTokenInput("");
					}}
					className="mt-4 min-h-[44px] rounded-lg bg-th-accent px-4 py-2 text-sm font-medium text-th-accent-text hover:bg-th-accent-hover"
				>
					Try Again
				</button>
			</div>
		);
	}

	// A reconnect normally keeps NodeList mounted so the last-known nodes stay on
	// screen. But when nothing was ever loaded (the app was opened while the
	// cluster was unreachable) that renders an empty list with no explanation,
	// and retries now run for as long as the tab is open, so version === null is
	// what says "we have never been connected, show the reason instead".
	if (status === "error" || (status === "reconnecting" && version === null)) {
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
					Cluster unreachable
				</h2>
				<p className="text-sm text-th-text-secondary">
					{errorMessage || "Can't reach the cluster server — retrying…"}
				</p>
				<button
					type="button"
					onClick={() => actions.connect(token)}
					className="mt-4 min-h-[44px] rounded-lg bg-th-accent px-4 py-2 text-sm font-medium text-th-accent-text hover:bg-th-accent-hover"
				>
					Retry
				</button>
			</div>
		);
	}

	return (
		<div className="flex min-h-dvh flex-col bg-th-bg-primary">
			<NodeList />
		</div>
	);
}
