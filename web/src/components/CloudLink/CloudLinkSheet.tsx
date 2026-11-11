import {
	type CloudLinkFlow,
	type CloudLinkStatus,
	displayUserCode,
	hostOf,
	isCloudLinkUnavailable,
	isFlowRunning,
	QrCode,
	spokenUserCode,
	useHasFinePointer,
} from "@pockode/shared";
import {
	AlertTriangle,
	CheckCircle2,
	ExternalLink,
	Info,
	XCircle,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { isInvalidParamsRejection, useWSStore } from "../../lib/wsStore";
import { errorMessage } from "../../utils/errorMessage";
import {
	ExpiryLine,
	Outcome,
	primaryButtonClass,
	SignInLink,
	secondaryButtonClass,
	textButtonClass,
} from "../CliLogin/loginParts";
import { Sheet, Spinner } from "../ui";
import { instanceLine, leftBehindText, SCOPE_SENTENCE } from "./cloudLinkText";

interface Props {
	/**
	 * The last status read: the machine's name, the cloud, and the relay
	 * after linking.
	 */
	status: CloudLinkStatus | undefined;
	/** The section's copy of the latest flow. */
	flow: CloudLinkFlow | null;
	/** Start a flow on opening; otherwise the sheet opens on the running one. */
	startOnOpen: boolean;
	/** A `start` or `cancel` reply, for the section's copy. */
	onFlow: (flow: CloudLinkFlow, startedHere?: boolean) => void;
	/** `start` answered that this process cannot keep a link. */
	onUnavailable: () => void;
	/**
	 * `start` was refused after the sheet was put away, so the sheet cannot
	 * say so itself.
	 */
	onStartRefused: (error: string) => void;
	/** Puts the sheet away. The flow keeps running: only Cancel ends it. */
	onClose: () => void;
}

/** What the sheet is showing. */
type Shown =
	| { kind: "starting" }
	| { kind: "flow"; flow: CloudLinkFlow }
	/** The flow on screen was running, and the snapshot has none: a restart. */
	| { kind: "restarted" };

/**
 * Which flow the sheet shows, given the one it showed last (`pinned`) and the
 * section's copy (docs/cloud-link-ui.md, "Which flow it shows" and "Closing
 * and cancelling"). The copy is always the newest news, so a flow started
 * elsewhere replaces the one on screen; but an ending already on screen is
 * how that flow ended, and is not traded for another ended flow, nor for a
 * restart's empty snapshot.
 */
function pick(pinned: CloudLinkFlow | null, copy: CloudLinkFlow | null): Shown {
	if (!copy) {
		if (!pinned) return { kind: "starting" };
		return isFlowRunning(pinned)
			? { kind: "restarted" }
			: { kind: "flow", flow: pinned };
	}
	if (
		!pinned ||
		copy.id === pinned.id ||
		isFlowRunning(pinned) ||
		isFlowRunning(copy)
	) {
		return { kind: "flow", flow: copy };
	}
	return { kind: "flow", flow: pinned };
}

/**
 * Links this machine to the cloud account: the process runs the device flow,
 * and the sheet shows its code and link and how it ended
 * (docs/cloud-link-ui.md, "The link sheet"). Closing it in any way but Cancel
 * leaves the flow running, where the card and the next opening find it.
 */
export default function CloudLinkSheet({
	status,
	flow,
	startOnOpen,
	onFlow,
	onUnavailable,
	onStartRefused,
	onClose,
}: Props) {
	const cloudLinkStart = useWSStore((s) => s.actions.cloudLinkStart);
	const cloudLinkCancel = useWSStore((s) => s.actions.cloudLinkCancel);
	const connected = useWSStore((s) => s.status === "connected");

	const [pinned, setPinned] = useState<CloudLinkFlow | null>(null);
	const [starting, setStarting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);
	const [cancelling, setCancelling] = useState(false);
	// Kept with the flow it was about: a flow started elsewhere since has had
	// no cancel fail.
	const [cancelError, setCancelError] = useState<{
		flowId: string;
		message: string;
	} | null>(null);

	// Replies that land after the sheet closed still feed the section's copy,
	// but no longer move a sheet that is gone.
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const start = async () => {
		setStarting(true);
		setStartError(null);
		setCancelError(null);
		try {
			const started = await cloudLinkStart();
			onFlow(started, true);
			if (!mounted.current) return;
			// The copy now holds this flow or something newer; show that.
			setPinned(null);
			setStarting(false);
		} catch (err) {
			if (isCloudLinkUnavailable(err)) {
				onUnavailable();
				if (mounted.current) onClose();
				return;
			}
			if (!mounted.current) {
				onStartRefused(errorMessage(err));
				return;
			}
			setStartError(errorMessage(err));
			setStarting(false);
		}
	};

	// Once per opening, StrictMode's second effect run included: the server
	// would answer a second start with the same flow, but it is a request
	// nobody made.
	const startOnOpenRef = useRef(startOnOpen);
	const startRef = useRef(start);
	startRef.current = start;
	useEffect(() => {
		if (!startOnOpenRef.current) return;
		startOnOpenRef.current = false;
		void startRef.current();
	}, []);

	// A refused start is moot once a flow runs — another screen started one —
	// and the sheet follows that flow from here as any other.
	if (startError && flow && isFlowRunning(flow)) setStartError(null);

	let shown: Shown;
	if (starting || startError) {
		// Until the reply lands, a running flow is the one starting (another
		// screen started it a moment earlier); an ended one is an earlier
		// attempt, not this one.
		shown =
			flow && isFlowRunning(flow)
				? { kind: "flow", flow }
				: { kind: "starting" };
	} else {
		shown = pick(pinned, flow);
		// The canceled copy can land before the reply; the sheet closes on the
		// reply, and must not flash "cancelled" at the one who cancelled.
		if (
			cancelling &&
			shown.kind === "flow" &&
			shown.flow.phase === "canceled" &&
			pinned?.id === shown.flow.id
		) {
			shown = { kind: "flow", flow: pinned };
		}
	}
	const shownFlow = shown.kind === "flow" ? shown.flow : null;
	if (shownFlow && shownFlow !== pinned) setPinned(shownFlow);

	const cancel = async () => {
		if (!shownFlow) return;
		setCancelling(true);
		setCancelError(null);
		try {
			const after = await cloudLinkCancel(shownFlow.id);
			onFlow(after);
			if (!mounted.current) return;
			if (after.phase === "canceled") {
				onClose();
				return;
			}
			// The approval landed first: the sheet stays on the phase it reached.
		} catch (err) {
			if (!mounted.current) return;
			// Invalid params: a newer flow replaced this one, and the sheet follows
			// it as it would on its notification. Anything else may have left the
			// flow running, and the user must not be told otherwise.
			if (!isInvalidParamsRejection(err)) {
				setCancelError({
					flowId: shownFlow.id,
					message: `Couldn't cancel: ${errorMessage(err)}`,
				});
			}
		}
		setCancelling(false);
	};

	// The live region is mounted empty and written from the next task on: a
	// region born with its text is often not read at all, and an effect is no
	// later than that — after a click React runs it before the first paint.
	const [regionReady, setRegionReady] = useState(false);
	useEffect(() => {
		const timer = setTimeout(() => setRegionReady(true), 0);
		return () => clearTimeout(timer);
	}, []);
	const cloudUrl = status?.cloud_url ?? "";
	const host = hostOf(cloudUrl);

	const closeButton = (
		<button
			type="button"
			onClick={onClose}
			className={`${secondaryButtonClass} flex-1`}
		>
			Close
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
	const againButton = (label: string) => (
		<button
			type="button"
			onClick={() => void start()}
			disabled={!connected}
			className={`${primaryButtonClass} flex-1`}
		>
			{label}
		</button>
	);
	const cancelButton = (
		<button
			type="button"
			onClick={() => void cancel()}
			// The id comes with the start reply or the flow's notification; without
			// a connection the request could not be sent.
			disabled={!shownFlow || cancelling || !connected}
			className={`${secondaryButtonClass} flex-1`}
		>
			{(!shownFlow || cancelling) && (
				<Spinner variant="current" srText={null} />
			)}
			{cancelling ? "Cancelling…" : "Cancel"}
		</button>
	);
	const leftBehind = shownFlow?.left_behind && (
		<div className="space-y-1 rounded-md border border-th-warning/40 px-3 py-2">
			<p className="flex gap-2 text-sm text-th-text-primary">
				<AlertTriangle
					className="mt-0.5 h-4 w-4 shrink-0 text-th-warning"
					aria-hidden="true"
				/>
				{leftBehindText(cloudUrl)}
			</p>
			<div className="flex justify-end">
				<a
					href={cloudUrl}
					target="_blank"
					rel="noopener noreferrer"
					className={textButtonClass}
				>
					Open {host}
					<ExternalLink className="h-4 w-4" aria-hidden="true" />
				</a>
			</div>
		</div>
	);

	let announcement: string;
	let body: ReactNode;
	let footer: ReactNode = null;
	// Whether the footer is Cancel's: its error is about that button, and
	// would read as being about the link once the flow has moved on.
	let cancellable = false;

	if (shown.kind === "starting" || shownFlow?.phase === "starting") {
		announcement = "Starting…";
		body = <SpinnerLine>Starting…</SpinnerLine>;
		cancellable = !startError;
		footer = startError ? (
			<>
				{closeButton}
				{againButton("Try again")}
			</>
		) : (
			cancelButton
		);
	} else if (shown.kind === "restarted") {
		announcement = "Pockode restarted, so linking stopped.";
		body = (
			<Outcome
				icon={<AlertTriangle className="h-5 w-5 text-th-warning" />}
				title="Pockode restarted, so linking stopped."
			/>
		);
		footer = (
			<>
				{closeButton}
				{againButton("Start again")}
			</>
		);
	} else if (shownFlow?.phase === "waiting") {
		announcement = "Waiting for approval";
		body = <Waiting flow={shownFlow} connected={connected} />;
		cancellable = true;
		footer = cancelButton;
	} else if (shownFlow?.phase === "finishing") {
		// No Cancel: a flow holding a token can no longer be cancelled.
		announcement = "Approved, saving the link…";
		body = <SpinnerLine>Approved, saving the link…</SpinnerLine>;
	} else if (shownFlow?.phase === "linked") {
		announcement = "This machine is linked";
		const relay = status?.relay;
		const line =
			relay && relay !== "link_invalid" ? instanceLine(relay, cloudUrl) : null;
		body = (
			<div className="space-y-4">
				<Outcome
					icon={<CheckCircle2 className="h-5 w-5 text-th-success" />}
					title="This machine is linked"
				>
					{shownFlow.email ? `Linked as ${shownFlow.email}` : null}
				</Outcome>
				{line && (
					<p className="flex items-center gap-2 pl-8 text-sm text-th-text-secondary">
						<span
							className="flex h-5 w-4 items-center justify-center"
							aria-hidden="true"
						>
							{line.icon}
						</span>
						{line.title}
					</p>
				)}
			</div>
		);
		footer = (
			<>
				<a
					href={cloudUrl}
					target="_blank"
					rel="noopener noreferrer"
					className={`${secondaryButtonClass} flex-1`}
				>
					Open {host}
					<ExternalLink className="h-4 w-4" aria-hidden="true" />
				</a>
				{doneButton}
			</>
		);
	} else if (shownFlow?.phase === "already_linked") {
		announcement = "Already linked";
		body = (
			<div className="space-y-4">
				<Outcome
					icon={<Info className="h-5 w-5 text-th-text-muted" />}
					title="Already linked"
				>
					{shownFlow.email
						? `This machine is linked as ${shownFlow.email}.`
						: "This machine is already linked."}{" "}
					To use another account, unlink first.
				</Outcome>
				{leftBehind}
			</div>
		);
		footer = doneButton;
	} else if (shownFlow?.phase === "failed") {
		const failure = describeFailure(shownFlow);
		announcement = failure.title;
		body = (
			<div className="space-y-4">
				<Outcome
					icon={<AlertTriangle className="h-5 w-5 text-th-error" />}
					title={failure.title}
					details={failure.details}
				>
					{failure.body}
				</Outcome>
				{leftBehind}
			</div>
		);
		footer = (
			<>
				{closeButton}
				{againButton(failure.retry)}
			</>
		);
	} else {
		announcement = "Linking was cancelled";
		body = (
			<Outcome
				icon={<XCircle className="h-5 w-5 text-th-text-muted" />}
				title="Linking was cancelled"
			>
				It was cancelled here or on another screen.
			</Outcome>
		);
		footer = (
			<>
				{closeButton}
				{againButton("Start again")}
			</>
		);
	}

	return (
		<Sheet
			title="Link this machine"
			subtitle={status?.machine_name}
			onClose={onClose}
			dismissible={!cancelling}
			footer={
				footer && (
					<div className="w-full space-y-2">
						{cancellable &&
							cancelError &&
							cancelError.flowId === shownFlow?.id && (
								<p className="text-xs text-th-error" role="alert">
									{cancelError.message}
								</p>
							)}
						<div className="flex gap-3">{footer}</div>
					</div>
				)
			}
		>
			<div className="space-y-4 p-4">
				{/* One live region for the whole flow, so each phase is heard once; the
				    countdown stays out of it. */}
				<output className="sr-only">{regionReady ? announcement : ""}</output>
				{body}
				{startError && (
					<p className="text-xs text-th-error" role="alert">
						Couldn't start linking: {startError}
					</p>
				)}
			</div>
		</Sheet>
	);
}

function SpinnerLine({ children }: { children: ReactNode }) {
	return (
		<p className="flex items-center gap-2 text-sm text-th-text-secondary">
			<Spinner srText={null} />
			{children}
		</p>
	);
}

/**
 * The code and the link, ordered by what is most likely to reach a browser
 * signed in to the cloud: on a phone its own browser, so the link leads; on a
 * desktop the phone in the user's pocket, so the QR code does.
 */
function Waiting({
	flow,
	connected,
}: {
	flow: CloudLinkFlow;
	connected: boolean;
}) {
	const finePointer = useHasFinePointer();
	const code = flow.user_code ?? "";
	const url = flow.verification_url ?? "";

	// The code is for checking the page approves this flow, not for typing —
	// the link carries it — so it has no Copy button: every copy is one more
	// place a secret goes.
	const codeBlock = (
		<div className="space-y-1.5">
			<p
				aria-hidden="true"
				className="rounded-lg bg-th-bg-tertiary px-4 py-3 text-center font-mono text-2xl tracking-widest text-th-text-primary"
			>
				{displayUserCode(code)}
			</p>
			<p className="sr-only">Code: {spokenUserCode(code)}</p>
			<p className="text-center text-xs text-th-text-muted">
				Approve only if the page shows this code.
			</p>
		</div>
	);

	return (
		<div className="space-y-5">
			<p className="text-sm text-th-text-secondary">{SCOPE_SENTENCE}</p>

			{finePointer && url ? (
				<div className="flex flex-col items-center gap-4 lg:flex-row lg:items-start">
					<QrCode value={url} label="QR code for the approval page" />
					<div className="w-full min-w-0 space-y-3">
						<div>
							<p className="text-sm font-medium text-th-text-primary">
								Scan with your phone
							</p>
							<p className="text-xs text-th-text-muted">
								Use a phone signed in to your cloud account.
							</p>
						</div>
						{codeBlock}
					</div>
				</div>
			) : (
				codeBlock
			)}

			{url && (
				<SignInLink
					url={url}
					label={finePointer ? "Open on this computer" : "Open approval page"}
					primary={!finePointer}
				/>
			)}

			<div className="space-y-1">
				{!connected ? (
					<SpinnerLine>Reconnecting…</SpinnerLine>
				) : flow.cloud_unreachable ? (
					<p className="flex items-center gap-2 text-sm text-th-text-secondary">
						<AlertTriangle
							className="h-4 w-4 shrink-0 text-th-warning"
							aria-hidden="true"
						/>
						Can't reach the cloud. Still trying until the code expires.
					</p>
				) : (
					<SpinnerLine>Waiting for approval…</SpinnerLine>
				)}
				{flow.expires_at && <ExpiryLine expiresAt={flow.expires_at} />}
			</div>
		</div>
	);
}

function describeFailure(flow: CloudLinkFlow): {
	title: string;
	body: ReactNode;
	retry: string;
	details?: string;
} {
	switch (flow.failure?.reason) {
		case "expired":
			return {
				title: "This code expired",
				body: "Codes work for a few minutes. Start again for a new one.",
				retry: "Start again",
			};
		case "declined":
			return {
				title: "Linking was declined",
				body: "It was declined on the approval page. Start again if that was a mistake.",
				retry: "Start again",
			};
		default:
			return {
				title: "Linking failed",
				body: (
					<>
						Try again, or link from a terminal on the machine with{" "}
						<code>pockode login</code>.
					</>
				),
				retry: "Try again",
				details: flow.failure?.detail,
			};
	}
}
