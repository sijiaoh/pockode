import { Spinner } from "@pockode/shared";
import { useEffect, useRef, useState } from "react";
import { NodeList } from "./components";
import { authActions } from "./lib/authStore";
import { useWSStore } from "./lib/wsStore";

/**
 * How long a connect may take before it is worth saying anything about.
 *
 * A local cluster answers well inside this, and a spinner that appears and
 * disappears inside a few frames reads as a glitch rather than as progress.
 */
const CONNECTING_SPINNER_DELAY_MS = 300;

export default function App() {
	const { status, errorMessage, actions, version, reauthReason } = useWSStore();
	const [passwordInput, setPasswordInput] = useState("");
	const [passwordVisible, setPasswordVisible] = useState(false);
	const [inputError, setInputError] = useState<string | null>(null);
	const [spinnerVisible, setSpinnerVisible] = useState(false);
	const [linkLoginRefused, setLinkLoginRefused] = useState(false);
	const passwordRef = useRef<HTMLInputElement>(null);

	const connecting = status === "connecting";

	useEffect(() => {
		if (!connecting) {
			setSpinnerVisible(false);
			return;
		}
		const timer = setTimeout(
			() => setSpinnerVisible(true),
			CONNECTING_SPINNER_DELAY_MS,
		);
		return () => clearTimeout(timer);
	}, [connecting]);

	// `?password=` (and its older `?token=` spelling) used to sign the user in.
	// It is gone: a password in a URL is already in history, in bookmark sync,
	// in referrers and in access logs by the time the page can strip it, and it
	// was the one path where the panel did *not* ask. Still strip it — dropping
	// the feature is no reason to leave a password in the address bar — and say
	// so, so an old bookmark fails out loud instead of looking broken.
	//
	// TODO: Drop the `token` spelling in v0.20.0, with the rest of the
	// auth-token deprecations.
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		if (params.has("password") || params.has("token")) {
			window.history.replaceState({}, "", window.location.pathname);
			setLinkLoginRefused(true);
		}
	}, []);

	// A refused password is usually one mistyped character on a phone keyboard.
	// Keep what was typed and put the caret back on it, selected: retyping from
	// scratch and fixing one character are both one gesture away.
	useEffect(() => {
		if (status === "auth_failed") {
			passwordRef.current?.focus();
			passwordRef.current?.select();
		}
	}, [status]);

	const handleSubmitPassword = (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = passwordInput.trim();
		if (!trimmed) {
			setInputError("Password is required.");
			return;
		}
		setInputError(null);
		// The link notice has done its job the moment a password is typed by
		// hand; leaving it up would have it reappear beside a later refusal,
		// explaining something the user is no longer doing.
		setLinkLoginRefused(false);
		authActions.login(trimmed);
		// Connect from here rather than from an effect watching the credential:
		// after a refusal the status is "auth_failed", not "disconnected", so any
		// such effect would sit out the retry and leave the button doing nothing.
		actions.connect({ kind: "password", value: trimmed });
	};

	const describedBy = [
		reauthReason === "session_expired" && "reauth-notice",
		linkLoginRefused && "link-notice",
		"password-help",
	]
		.filter(Boolean)
		.join(" ");

	// `version === null` is this tab saying it has never been connected. Which
	// screen to show turns on that alone; `status` only decides what the
	// password screen looks like while it is up. Anything else needs two
	// conditions to agree about where the user is, and they eventually won't.
	if (version === null) {
		if (status === "error" || status === "reconnecting") {
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
					{/* retryNow, not connect: it keeps the "reconnecting" status, so a
					    hand-pressed retry stays on this screen instead of flipping to
					    the password screen and back. */}
					<button
						type="button"
						onClick={() => actions.retryNow()}
						className="mt-4 min-h-[44px] rounded-lg bg-th-accent px-4 py-2 text-sm font-medium text-th-accent-text hover:bg-th-accent-hover"
					>
						Retry
					</button>
					{/* Retrying uses the password held in memory. If the cluster came
					    back up under a different one, that retry can never succeed and
					    this screen is a dead end without a way out. */}
					<button
						type="button"
						onClick={() => {
							actions.disconnect();
							authActions.logout();
							setPasswordInput("");
						}}
						className="touch-target text-sm text-th-text-secondary underline hover:text-th-text-primary"
					>
						Use a different password
					</button>
				</div>
			);
		}

		return (
			<div className="flex min-h-dvh items-center justify-center bg-th-bg-primary p-4">
				<div className="w-full max-w-sm">
					<h1 className="text-center text-2xl font-bold text-th-text-primary">
						Pockode Cluster
					</h1>

					<form onSubmit={handleSubmitPassword} className="mt-8">
						<label
							htmlFor="password"
							className="mb-1 block text-sm text-th-text-secondary"
						>
							Password
						</label>
						{/* An ordinary reload lands here with nothing above the field, on
						    purpose: that is the product working as described, and an
						    apology for it would suggest something had broken. Only a real
						    event gets a line. */}
						{reauthReason === "session_expired" && (
							<p
								id="reauth-notice"
								className="mb-2 text-sm text-th-text-secondary"
							>
								The cluster no longer accepts this session — enter the password
								again.
							</p>
						)}
						{linkLoginRefused && (
							<p
								id="link-notice"
								className="mb-2 text-sm text-th-text-secondary"
							>
								Password links are no longer accepted. Enter the password to
								connect.
							</p>
						)}
						{/* A cluster password is long, random and usually typed on a
						    phone keyboard; typing it blind is the worst moment in the
						    product, so it can be read back. */}
						<div className="relative">
							<input
								id="password"
								name="password"
								ref={passwordRef}
								type={passwordVisible ? "text" : "password"}
								// Kept on, though nothing is persisted: browsers ignore
								// autoComplete="off" on password fields anyway, and a password
								// manager is a better keeper than this app was — the user opts
								// in, the store is encrypted, and they can delete it.
								autoComplete="current-password"
								value={passwordInput}
								onChange={(e) => setPasswordInput(e.target.value)}
								placeholder="Enter your password"
								className="min-h-[44px] w-full rounded-lg border border-th-border bg-th-bg-secondary py-2 pl-3 pr-16 font-mono text-sm text-th-text-primary placeholder:font-sans placeholder:text-th-text-muted focus:border-th-border-focus focus:outline-none"
								// Whichever notice is up describes the field rather than merely
								// sitting above it: this screen takes focus here the moment it
								// mounts, so a line not read out with the field is one a
								// screen reader user never gets — and a lapsed session mounts
								// the screen under them, with no reload of their own to
								// explain it. Neither notice exists on an ordinary load, so
								// an ordinary load still describes nothing but the help text.
								aria-describedby={describedBy}
								aria-invalid={Boolean(inputError) || status === "auth_failed"}
								autoCapitalize="off"
								autoCorrect="off"
								spellCheck={false}
								autoFocus
							/>
							{/* The name carries the state, so no aria-pressed beside it: a
							    toggle that does both is announced "Hide password, pressed",
							    saying the same thing twice in two vocabularies (APG says to
							    pick one). The name is the half worth keeping — a bare "Show"
							    was unreadable out of context, which is the actual complaint. */}
							<button
								type="button"
								onClick={() => setPasswordVisible((visible) => !visible)}
								className="touch-target absolute inset-y-0 right-0 flex items-center px-3 text-xs font-medium text-th-text-secondary hover:text-th-text-primary"
							>
								{passwordVisible ? "Hide password" : "Show password"}
							</button>
						</div>
						{/* Described by the field rather than merely placed under it:
						    where the password comes from is the answer to the question
						    the field raises, and a reader who never sees the layout
						    would otherwise never be given it. "Asked again" belongs in
						    the same breath — it is the second half of that question. */}
						<p id="password-help" className="mt-1 text-xs text-th-text-muted">
							The <code className="font-mono">--password</code> you started the
							cluster with. It's kept in this tab only, so you'll be asked again
							after a reload.
						</p>
						{/* Both errors are announced: the field is autofocused, so a
						    screen reader user pressing Connect hears nothing at all
						    unless the message claims their attention. */}
						{inputError && (
							<p className="mt-2 text-sm text-th-error" role="alert">
								{inputError}
							</p>
						)}
						{/* A refusal is reported here rather than on a screen of its own:
						    it is now the commonest outcome of a wrong keystroke, and the
						    fix is in the field a line above. */}
						{status === "auth_failed" && (
							<p className="mt-2 text-sm text-th-error" role="alert">
								{errorMessage || "Check the cluster password and try again."}
							</p>
						)}
						<button
							type="submit"
							disabled={connecting}
							aria-busy={connecting}
							className="mt-4 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-th-accent py-2 text-sm font-medium text-th-accent-text hover:bg-th-accent-hover disabled:opacity-70"
						>
							{/* aria-busy already announces the wait; a second "Loading" would
							    only bloat the button's accessible name. */}
							{connecting && spinnerVisible && (
								<Spinner size="h-4 w-4" variant="current" srText={null} />
							)}
							{connecting ? "Connecting…" : "Connect"}
						</button>
					</form>
				</div>
			</div>
		);
	}

	return (
		<div className="flex min-h-dvh flex-col bg-th-bg-primary">
			<NodeList />
		</div>
	);
}
