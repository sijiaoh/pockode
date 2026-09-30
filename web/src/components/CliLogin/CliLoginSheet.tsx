import {
	AlertTriangle,
	CheckCircle2,
	CircleSlash,
	Info,
	XCircle,
} from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useCliLoginSubscription } from "../../hooks/useCliLoginSubscription";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { getAgentLabel } from "../../lib/agentType";
import {
	cliLoginActions,
	isLoginEnded,
	useCliLoginStore,
} from "../../lib/cliLoginStore";
import type {
	CliAccount,
	CliAccountKind,
	CliAuthStatus,
	CliLogin,
} from "../../types/cliAuth";
import type { AgentType } from "../../types/settings";
import { errorMessage } from "../../utils/errorMessage";
import { Sheet, Spinner } from "../ui";
import {
	accountSummary,
	ExternalSource,
	InstallLink,
	NotInstalledHint,
} from "./cliAuthText";
import DeviceCodeStep from "./DeviceCodeStep";
import { describeFailure } from "./loginOutcome";
import {
	Details,
	primaryButtonClass,
	secondaryButtonClass,
} from "./loginParts";
import PastedCodeStep from "./PastedCodeStep";

interface Props {
	agent: AgentType;
	/**
	 * Puts the sheet away. The sign-in keeps running: only the sheet's own
	 * Cancel ends it.
	 */
	onClose: () => void;
	/**
	 * Offered by the chat's way in, for a failed turn whose message can be put
	 * back (docs/cli-login-ui.md#after-signing-in-send-again). Shown once the
	 * CLI is signed in.
	 */
	sendAgain?: SendAgainOffer;
}

export interface SendAgainOffer {
	/** The failed turn's message, as the user typed it. */
	text: string;
	/**
	 * The session's input already holds a draft. Send again must not replace
	 * it, so the message is offered for copying instead.
	 */
	draftKept: boolean;
	/** Puts `text` into the session's input, unsent, and puts the sheet away. */
	onSendAgain: () => void;
}

type View =
	/** Reading live status to decide what the sheet is for. */
	| { kind: "resolving" }
	/** No sign-in to run: the CLI is signed in, managed elsewhere, missing, or unreadable. */
	| { kind: "status"; status: CliAuthStatus }
	/** A sign-in, by id; null while the request starting it is out. */
	| { kind: "flow"; loginId: string | null }
	| { kind: "start_failed"; error: string };

/**
 * Signs a CLI in, from Settings or from a failed chat turn — one flow, two ways
 * in (docs/cli-login-ui.md).
 *
 * It reads live status first and only starts a sign-in when the CLI is signed
 * out and none is running; a running one is picked up, never replaced. Closing
 * the sheet in any way but Cancel leaves the sign-in running on the server,
 * where the CLI's card and the next opening find it.
 */
export default function CliLoginSheet({ agent, onClose, sendAgain }: Props) {
	useCliLoginSubscription(agent);
	const label = getAgentLabel(agent);
	const storedLogin = useCliLoginStore((s) => s.logins[agent]);
	const loginError = useCliLoginStore((s) => s.loginErrors[agent]);

	const [view, setView] = useState<View>({ kind: "resolving" });
	const [code, setCode] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [cancelling, setCancelling] = useState(false);
	// Two errors, because they are about two things: a refused code belongs
	// under the field, anything else about the sign-in above it.
	const [actionError, setActionError] = useState<string | null>(null);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const { state: messageCopy, copy: copyMessage } = useCopyToClipboard();

	// Each resolve or start bumps this; a continuation that finds it moved on
	// was overtaken (another start, Cancel, the sheet closing) and does nothing.
	const generation = useRef(0);
	// The request starting a sign-in, so a Cancel pressed while it is out can
	// still name the sign-in it started.
	const pendingStart = useRef<Promise<CliLogin> | null>(null);

	// An ended sign-in the server has since forgotten (it restarted): still
	// what happened, and still what the sheet shows until the user moves on.
	const [forgotten, setForgotten] = useState<CliLogin | null>(null);
	const login =
		view.kind !== "flow"
			? undefined
			: storedLogin?.id === view.loginId
				? storedLogin
				: forgotten?.id === view.loginId
					? forgotten
					: undefined;

	const start = useCallback(
		async (accountKind?: CliAccountKind) => {
			const gen = ++generation.current;
			setView({ kind: "flow", loginId: null });
			setActionError(null);
			setSubmitError(null);
			setCode("");
			const request = cliLoginActions.startLogin(agent, accountKind);
			pendingStart.current = request;
			try {
				const started = await request;
				if (generation.current === gen) {
					setView({ kind: "flow", loginId: started.id });
				}
			} catch (err) {
				if (generation.current === gen) {
					setView({ kind: "start_failed", error: errorMessage(err) });
				}
			} finally {
				if (pendingStart.current === request) pendingStart.current = null;
			}
		},
		[agent],
	);

	const resolve = useCallback(async () => {
		const gen = ++generation.current;
		setView({ kind: "resolving" });
		setActionError(null);

		const known = useCliLoginStore.getState().logins[agent];
		if (known && !isLoginEnded(known)) {
			setView({ kind: "flow", loginId: known.id });
			return;
		}

		const [status] = await cliLoginActions.refreshStatus(agent);
		if (generation.current !== gen) return;
		if (status.state === "signed_out") {
			void start();
		} else if (status.state === "signing_in") {
			setView({
				kind: "flow",
				loginId:
					status.login_id ??
					useCliLoginStore.getState().logins[agent]?.id ??
					null,
			});
		} else {
			setView({ kind: "status", status });
		}
	}, [agent, start]);

	useEffect(() => {
		void resolve();
		return () => {
			generation.current++;
		};
	}, [resolve]);

	// The sign-in on screen can be overtaken — another screen starts a newer
	// one, or a restarted server has none — and waiting on it then would spin
	// forever. A newer running one is followed. A running one gone with nothing
	// after it is resolved afresh; an ended one gone is kept on screen, since
	// resolving would start a sign-in nobody asked for. An ended copy of another
	// id is not followed: it is an older one the subscription has not caught up
	// past yet.
	const lastStored = useRef(storedLogin);
	useEffect(() => {
		const before = lastStored.current;
		lastStored.current = storedLogin;
		if (view.kind !== "flow" || !view.loginId) return;
		if (
			storedLogin &&
			storedLogin.id !== view.loginId &&
			!isLoginEnded(storedLogin)
		) {
			setView({ kind: "flow", loginId: storedLogin.id });
			setCode("");
		} else if (!storedLogin && before?.id === view.loginId) {
			if (isLoginEnded(before)) setForgotten(before);
			else void resolve();
		}
	}, [storedLogin, view, resolve]);

	const cancel = async () => {
		generation.current++;
		let loginId = view.kind === "flow" ? view.loginId : null;
		setCancelling(true);
		setActionError(null);
		try {
			if (!loginId && pendingStart.current) {
				// A start that failed left nothing running to cancel.
				loginId = await pendingStart.current.then(
					(started) => started.id,
					() => null,
				);
				// Shown if the cancel below fails: the sign-in is running.
				if (loginId) setView({ kind: "flow", loginId });
			}
			if (loginId) await cliLoginActions.cancelLogin(agent, loginId);
			onClose();
		} catch (err) {
			// The sign-in may still be running; say so rather than close on it.
			setActionError(`Couldn't cancel the sign-in: ${errorMessage(err)}`);
			setCancelling(false);
		}
	};

	const switchAccountKind = async (kind: CliAccountKind) => {
		if (!login) return;
		const gen = ++generation.current;
		const loginId = login.id;
		// Off the old sign-in at once: its cancelled copy is on its way, and is
		// not an ending to offer Start again on.
		setView({ kind: "flow", loginId: null });
		setActionError(null);
		try {
			// One sign-in per CLI: the running one has to end before one of the
			// other kind can start.
			await cliLoginActions.cancelLogin(agent, loginId);
		} catch (err) {
			if (generation.current === gen) {
				setView({ kind: "flow", loginId });
				setActionError(errorMessage(err));
			}
			return;
		}
		// Closed or cancelled meanwhile: starting now would leave a sign-in
		// nobody asked for holding the CLI for 15 minutes.
		if (generation.current === gen) void start(kind);
	};

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		// Codes are pasted with a trailing newline more often than not.
		const trimmed = code.trim();
		if (!login || login.phase !== "waiting" || !trimmed || submitting) return;
		setSubmitting(true);
		setSubmitError(null);
		try {
			await cliLoginActions.submitCode(agent, login.id, trimmed);
		} catch (err) {
			setSubmitError(errorMessage(err));
		} finally {
			setSubmitting(false);
		}
	};

	const inFlow =
		view.kind === "resolving" ||
		(view.kind === "flow" && (!login || !isLoginEnded(login)));
	// Without a subscription the verdict can never arrive, and a sheet that
	// refuses to close while waiting for it would hold the user until a reload.
	const verifying = submitting || (login?.phase === "verifying" && !loginError);
	const pastingCode =
		agent === "claude" &&
		!!login &&
		(login.phase === "waiting" || login.phase === "verifying");

	const retryAction = (text: string, run: () => void) => (
		<button
			type="button"
			onClick={run}
			className={`${primaryButtonClass} flex-1`}
		>
			{text}
		</button>
	);
	const closeButton = (text = "Close") => (
		<button
			type="button"
			onClick={onClose}
			className={`${secondaryButtonClass} flex-1`}
		>
			{text}
		</button>
	);
	const doneButton = (
		<button
			type="button"
			onClick={onClose}
			className={`${primaryButtonClass} flex-1`}
		>
			Done
		</button>
	);
	// What the sheet ends on once the CLI is signed in.
	const signedInFooter = sendAgain ? (
		<>
			{closeButton("Done")}
			{sendAgain.draftKept ? (
				<button
					type="button"
					onClick={() => void copyMessage(sendAgain.text)}
					className={`${primaryButtonClass} flex-1`}
				>
					{messageCopy === "copied" ? "Message copied" : "Copy message"}
				</button>
			) : (
				<button
					type="button"
					onClick={sendAgain.onSendAgain}
					className={`${primaryButtonClass} flex-1`}
				>
					Send again
				</button>
			)}
		</>
	) : (
		doneButton
	);
	const signedInNote = sendAgain?.draftKept && (
		<div className="space-y-1">
			<p className="text-sm text-th-text-secondary">Your draft was kept.</p>
			{messageCopy === "failed" && (
				<>
					<p className="text-xs text-th-error" role="alert">
						Couldn't copy. Select the message below and copy it by hand.
					</p>
					<p className="select-all whitespace-pre-wrap break-words rounded-md bg-th-bg-tertiary p-3 text-sm text-th-text-primary">
						{sendAgain.text}
					</p>
				</>
			)}
		</div>
	);

	let body: ReactNode;
	let footer: ReactNode;
	let announcement: string;

	if (inFlow) {
		footer = (
			<>
				<button
					type="button"
					onClick={cancel}
					disabled={cancelling || verifying}
					className={`${secondaryButtonClass} flex-1`}
				>
					{cancelling && <Spinner variant="current" srText={null} />}
					{cancelling ? "Cancelling…" : "Cancel"}
				</button>
				{pastingCode && (
					<button
						type="submit"
						disabled={!code.trim() || verifying || login?.phase !== "waiting"}
						className={`${primaryButtonClass} flex-1`}
					>
						{verifying && <Spinner variant="current" srText={null} />}
						{verifying ? "Verifying…" : "Sign in"}
					</button>
				)}
			</>
		);
		if (!login || login.phase === "starting") {
			// Reading status can take a while and may end in "already signed in",
			// so it does not claim a sign-in is starting.
			announcement =
				view.kind === "resolving"
					? "Checking sign-in status…"
					: "Starting sign-in…";
			body = (
				<p className="flex items-center gap-2 text-sm text-th-text-secondary">
					<Spinner srText={null} />
					{announcement}
				</p>
			);
		} else if (agent === "claude") {
			announcement = verifying
				? "Verifying the code…"
				: "Waiting for the code from the sign-in page";
			body = (
				<PastedCodeStep
					login={login}
					code={code}
					onCodeChange={setCode}
					verifying={verifying}
					submitError={submitError}
					onSwitchAccountKind={switchAccountKind}
				/>
			);
		} else {
			announcement = "Waiting for you to finish in the browser";
			body = <DeviceCodeStep login={login} />;
		}
	} else if (view.kind === "flow" && login) {
		const again = () => void start(login.account_kind);
		if (login.phase === "succeeded") {
			announcement = `Signed in to ${label}`;
			body = (
				<>
					<SignedIn title={`Signed in to ${label}`} account={login.account} />
					{signedInNote}
				</>
			);
			footer = signedInFooter;
		} else if (login.phase === "canceled") {
			announcement = "Sign-in cancelled";
			body = (
				<Outcome
					icon={<XCircle className="h-5 w-5 text-th-text-muted" />}
					title="This sign-in was cancelled"
				>
					It was cancelled before it finished, here or on another screen.
				</Outcome>
			);
			footer = (
				<>
					{closeButton()}
					{retryAction("Start again", again)}
				</>
			);
		} else {
			const failure = describeFailure(agent, login);
			announcement = failure.title;
			body = (
				<Outcome
					icon={<AlertTriangle className="h-5 w-5 text-th-error" />}
					title={failure.title}
					details={failure.details}
					detailsOpen={failure.detailsOpen}
				>
					{failure.body}
				</Outcome>
			);
			footer = (
				<>
					{closeButton()}
					{failure.install && <InstallLink agent={agent} variant="primary" />}
					{failure.retry && retryAction(failure.retry, again)}
				</>
			);
		}
	} else if (view.kind === "start_failed") {
		announcement = "Sign-in failed";
		body = (
			<Outcome
				icon={<AlertTriangle className="h-5 w-5 text-th-error" />}
				title="Sign-in failed"
			>
				{view.error}
			</Outcome>
		);
		footer = (
			<>
				{closeButton()}
				{retryAction("Try again", () => void resolve())}
			</>
		);
	} else if (view.kind === "status") {
		({ body, footer, announcement } = describeStatus(view.status, {
			doneButton: signedInFooter,
			closeButton,
			retry: retryAction("Retry", () => void resolve()),
		}));
		if (view.status.state === "signed_in") {
			body = (
				<>
					{body}
					{signedInNote}
				</>
			);
		}
	} else {
		// Unreachable: a flow without an ended sign-in is `inFlow` above. Here
		// only so that every branch assigns what the sheet draws.
		announcement = "";
		body = null;
		footer = closeButton();
	}

	return (
		<Sheet
			title={`Sign in to ${label}`}
			onClose={onClose}
			dismissible={!verifying}
			onSubmit={pastingCode ? submit : undefined}
			footer={footer}
		>
			<div className="space-y-4 p-4">
				{/* One live region for the whole flow, so each phase is heard once; the
				    countdown stays out of it. */}
				<output className="sr-only">{announcement}</output>
				{loginError && inFlow && (
					<p className="text-sm text-th-error" role="alert">
						Couldn't follow this sign-in: {loginError}
					</p>
				)}
				{actionError && (
					<p className="text-sm text-th-error" role="alert">
						{actionError}
					</p>
				)}
				{body}
			</div>
		</Sheet>
	);
}

function describeStatus(
	status: CliAuthStatus,
	parts: {
		doneButton: ReactNode;
		closeButton: () => ReactNode;
		retry: ReactNode;
	},
): { body: ReactNode; footer: ReactNode; announcement: string } {
	const label = getAgentLabel(status.agent);
	switch (status.state) {
		case "signed_in": {
			const email = status.account?.email;
			const title = email
				? `${label} is already signed in as ${email}`
				: `${label} is already signed in`;
			return {
				announcement: title,
				// The account is on the title already; only the plan is left.
				body: (
					<SignedIn
						title={title}
						account={email ? { plan: status.account?.plan } : status.account}
					/>
				),
				footer: parts.doneButton,
			};
		}
		case "external":
			return {
				announcement: "Managed outside Pockode",
				body: (
					<Outcome
						icon={<Info className="h-5 w-5 text-th-text-muted" />}
						title="Managed outside Pockode"
					>
						<ExternalSource agent={status.agent} external={status.external} />
					</Outcome>
				),
				footer: parts.closeButton(),
			};
		case "not_installed":
			return {
				announcement: `${label} isn't installed`,
				body: (
					<Outcome
						icon={<CircleSlash className="h-5 w-5 text-th-text-muted" />}
						title={`${label} isn't installed`}
					>
						<NotInstalledHint agent={status.agent} verb="try again" />
					</Outcome>
				),
				footer: (
					<>
						{parts.closeButton()}
						<InstallLink agent={status.agent} variant="primary" />
					</>
				),
			};
		case "updating":
			// The CLI's files are being replaced, so the server runs none of its
			// sign-in commands meanwhile (docs/cli-update-ui.md, "While it runs").
			return {
				announcement: `${label} is being updated`,
				body: (
					<Outcome
						icon={<Spinner srText={null} />}
						title={`${label} is being updated`}
					>
						Sign-in status is checked after the update. Wait for it to finish,
						then retry.
					</Outcome>
				),
				footer: (
					<>
						{parts.closeButton()}
						{parts.retry}
					</>
				),
			};
		default:
			return {
				announcement: "Couldn't read sign-in status",
				body: (
					<Outcome
						icon={<AlertTriangle className="h-5 w-5 text-th-error" />}
						title="Couldn't read sign-in status"
					>
						{status.error ?? "The server gave no reason."}
					</Outcome>
				),
				footer: (
					<>
						{parts.closeButton()}
						{parts.retry}
					</>
				),
			};
	}
}

function SignedIn({
	title,
	account,
}: {
	title: string;
	account: CliAccount | undefined;
}) {
	const summary = accountSummary(account);
	return (
		<Outcome
			icon={<CheckCircle2 className="h-5 w-5 text-th-success" />}
			title={title}
		>
			{summary || null}
		</Outcome>
	);
}

function Outcome({
	icon,
	title,
	children,
	details,
	detailsOpen = false,
}: {
	icon: ReactNode;
	title: string;
	children?: ReactNode;
	details?: string;
	detailsOpen?: boolean;
}) {
	return (
		<div className="space-y-3">
			<div className="flex gap-3">
				<span className="mt-0.5 shrink-0" aria-hidden="true">
					{icon}
				</span>
				<div className="min-w-0 space-y-1">
					<h3 className="text-sm font-medium text-th-text-primary">{title}</h3>
					{children && (
						<p className="break-words text-sm text-th-text-secondary">
							{children}
						</p>
					)}
				</div>
			</div>
			{details && <Details details={details} defaultOpen={detailsOpen} />}
		</div>
	);
}
