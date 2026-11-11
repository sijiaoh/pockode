import {
	type CloudLinkFlow,
	type CloudLinkStatus,
	displayUserCode,
	hostOf,
	isCloudLinkUnavailable,
	isFlowRunning,
	QrCode,
	Sheet,
	Spinner,
	spokenUserCode,
	useHasFinePointer,
} from "@pockode/shared";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { isInvalidParamsRejection, useWSStore } from "../lib/wsStore";
import { NEUTRAL_BUTTON, PRIMARY_BUTTON, TEXT_BUTTON } from "./buttons";
import {
	AlertIcon,
	CheckIcon,
	CrossIcon,
	ExpiryLine,
	ExternalIcon,
	InfoIcon,
	instanceLine,
	leftBehindText,
	OpenCloud,
	Outcome,
	SCOPE_SENTENCE,
	SpinnerLine,
} from "./cloudLinkParts";

interface Props {
	/** The last status read: the machine's name, the cloud, and the relay. */
	status: CloudLinkStatus | undefined;
	/** The latest flow the panel knows of. */
	flow: CloudLinkFlow | null;
	/** Start a flow on opening; otherwise this opens on the running one. */
	startOnOpen: boolean;
	/** A `start` or `cancel` reply, for the panel's copy. */
	onFlow: (flow: CloudLinkFlow, startedHere?: boolean) => void;
	/** `start` answered that this process cannot keep a link. */
	onUnavailable: () => void;
	/** `start` was refused after this view was left, so it cannot say so. */
	onStartRefused: (error: string) => void;
	/** Back to the Cloud sheet's status. The flow keeps running. */
	onBack: () => void;
	/** Puts the whole sheet away. The flow keeps running. */
	onClose: () => void;
}

/** What the view is showing. */
type Shown =
	| { kind: "starting" }
	| { kind: "flow"; flow: CloudLinkFlow }
	/** The flow on screen was running, and the snapshot has none: a restart. */
	| { kind: "restarted" };

/**
 * Which flow the view shows, given the one it showed last (`pinned`) and the
 * panel's copy (docs/cloud-link-ui.md, "Which flow it shows" and "Closing and
 * cancelling"). The copy is always the newest news, so a flow started
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

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * The Cloud sheet while it links this machine: the process runs the device
 * flow, and this shows its code and link and how it ended
 * (docs/cloud-link-ui.md, "The link sheet"). Leaving it any way but Cancel —
 * Back, Done, ✕ — leaves the flow running, where the status view and the
 * next opening find it.
 */
export function CloudLinkFlowSheet({
	status,
	flow,
	startOnOpen,
	onFlow,
	onUnavailable,
	onStartRefused,
	onBack,
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

	// Replies that land after the view was left still feed the panel's copy,
	// but no longer move a view that is gone.
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
				if (mounted.current) onBack();
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
	// and this follows that flow from here as any other.
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
		// The canceled copy can land before the reply; the view goes back on
		// the reply, and must not flash "cancelled" at the one who cancelled.
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
				onBack();
				return;
			}
			// The approval landed first: the view stays on the phase it reached.
		} catch (err) {
			if (!mounted.current) return;
			// Invalid params: a newer flow replaced this one, and the view follows
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
	// region born with its text is often not read at all.
	const [regionReady, setRegionReady] = useState(false);
	useEffect(() => {
		const timer = setTimeout(() => setRegionReady(true), 0);
		return () => clearTimeout(timer);
	}, []);
	const cloudUrl = status?.cloud_url ?? "";

	const backButton = (
		<button
			type="button"
			onClick={onBack}
			className={`${NEUTRAL_BUTTON} flex-1`}
		>
			Back
		</button>
	);
	const doneButton = (
		<button
			type="button"
			onClick={onBack}
			className={`${PRIMARY_BUTTON} flex-1`}
		>
			Done
		</button>
	);
	const againButton = (label: string) => (
		<button
			type="button"
			onClick={() => void start()}
			disabled={!connected}
			className={`${PRIMARY_BUTTON} flex-1`}
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
			className={`${NEUTRAL_BUTTON} flex-1`}
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
				<AlertIcon className="mt-0.5 text-th-warning" />
				{leftBehindText(cloudUrl)}
			</p>
			<div className="flex justify-end">
				<OpenCloud url={cloudUrl} />
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
				{backButton}
				{againButton("Try again")}
			</>
		) : (
			cancelButton
		);
	} else if (shown.kind === "restarted") {
		announcement = "The cluster restarted, so linking stopped.";
		body = (
			<Outcome
				icon={<AlertIcon size="h-5 w-5" className="text-th-warning" />}
				title="The cluster restarted, so linking stopped."
			/>
		);
		footer = (
			<>
				{backButton}
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
					icon={<CheckIcon size="h-5 w-5" className="text-th-success" />}
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
					className={`${NEUTRAL_BUTTON} flex-1`}
				>
					Open {hostOf(cloudUrl)}
					<ExternalIcon />
				</a>
				{doneButton}
			</>
		);
	} else if (shownFlow?.phase === "already_linked") {
		announcement = "Already linked";
		body = (
			<div className="space-y-4">
				<Outcome
					icon={<InfoIcon size="h-5 w-5" className="text-th-text-muted" />}
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
					icon={<AlertIcon size="h-5 w-5" className="text-th-error" />}
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
				{backButton}
				{againButton(failure.retry)}
			</>
		);
	} else {
		announcement = "Linking was cancelled";
		body = (
			<Outcome
				icon={<CrossIcon size="h-5 w-5" className="text-th-text-muted" />}
				title="Linking was cancelled"
			>
				It was cancelled here or on another screen.
			</Outcome>
		);
		footer = (
			<>
				{backButton}
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
				<ApprovalLink
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
						<AlertIcon className="text-th-warning" />
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

/**
 * The host and path, so the user sees which page they are about to approve
 * on; "…" when a query was left out.
 */
function displayUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const path = parsed.pathname === "/" ? "" : parsed.pathname;
		return `${parsed.host}${path}${parsed.search ? "…" : ""}`;
	} catch {
		return url;
	}
}

/**
 * The approval page's link and "Copy link", for doing the browser half on
 * another device; when copying fails — no clipboard outside a secure
 * context, which a cluster reached over plain HTTP is — the link is shown
 * whole so it can be copied by hand.
 */
function ApprovalLink({
	url,
	label,
	primary,
}: {
	url: string;
	label: string;
	primary: boolean;
}) {
	const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
	const onCopy = async () => {
		try {
			if (!navigator.clipboard) throw new Error("no clipboard");
			await navigator.clipboard.writeText(url);
			setCopy("copied");
		} catch {
			setCopy("failed");
		}
	};

	return (
		<div className="space-y-1.5">
			<div className="flex flex-wrap items-center gap-2">
				<a
					href={url}
					target="_blank"
					rel="noopener noreferrer"
					className={`${primary ? PRIMARY_BUTTON : NEUTRAL_BUTTON} flex-1`}
				>
					{label}
					<ExternalIcon />
				</a>
				<button type="button" onClick={onCopy} className={TEXT_BUTTON}>
					{copy === "copied" ? "Link copied" : "Copy link"}
				</button>
			</div>
			{copy === "failed" ? (
				<>
					<p className="text-xs text-th-error" role="alert">
						Couldn't copy. Select the link below and copy it by hand.
					</p>
					<p className="select-all break-all font-mono text-xs text-th-text-primary">
						{url}
					</p>
				</>
			) : (
				<p className="break-all text-xs text-th-text-muted">
					{displayUrl(url)}
				</p>
			)}
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
