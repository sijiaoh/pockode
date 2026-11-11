import {
	type CloudLinkFlow,
	type CloudLinkStatus,
	hostOf,
	isFlowRunning,
	Sheet,
	Spinner,
} from "@pockode/shared";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
	type CloudLinkRead,
	useCloudLinkSubscription,
} from "../hooks/useCloudLinkSubscription";
import { isConnectionLost, useWSStore } from "../lib/wsStore";
import {
	DANGER_BUTTON,
	NEUTRAL_BUTTON,
	PRIMARY_BUTTON,
	TEXT_BUTTON,
} from "./buttons";
import { CloudLinkFlowSheet } from "./CloudLinkFlowSheet";
import {
	AlertIcon,
	CloudIcon,
	Details,
	Dot,
	ExpiryText,
	INTRO,
	InfoIcon,
	instanceLine,
	leftBehindText,
	machineLabel,
	OpenCloud,
	type RowState,
	Warning,
} from "./cloudLinkParts";

/**
 * How a flow this panel watched running ended while its view was not up — or
 * a start from this panel refused after its view was left.
 */
type LastAttempt =
	| { kind: "ended"; flow: CloudLinkFlow }
	| { kind: "restarted" }
	| { kind: "refused"; error: string };

/** An unlink the cloud could not be told about. */
interface RevokeFailure {
	cloudUrl: string;
	error: string;
	machine: string;
}

/**
 * What the Cloud sheet shows. One sheet, its views swapped in place —
 * nothing in this panel stacks overlays (docs/cluster-ui.md, rule 3).
 */
type View =
	| { kind: "status" }
	| { kind: "flow"; startOnOpen: boolean }
	| { kind: "unlink" }
	| { kind: "link_over" };

const UNLINK_NO_ANSWER =
	"No answer came before the connection dropped. The status will show whether it went through.";

/**
 * The header's Cloud button and the sheet it opens: whether this machine is
 * linked to a cloud account, whether this cluster is in the account's list,
 * and Link and Unlink (docs/cloud-link-ui.md, the web Settings card this
 * follows). Housekeeping, so it is one icon in the header and nothing on the
 * list (docs/cluster-ui.md, "What the panel is for").
 *
 * The status is followed for as long as the header is up, not only while the
 * sheet is: a flow the user left running is told about when it ends, and the
 * sheet opens on what is already known.
 */
export function CloudLink() {
	const link = useCloudLinkSubscription();
	const { read, status, flow } = link;
	const connected = useWSStore((s) => s.status === "connected");
	const cloudLinkUnlink = useWSStore((s) => s.actions.cloudLinkUnlink);

	const [view, setView] = useState<View | null>(null);
	const [lastAttempt, setLastAttempt] = useState<LastAttempt | null>(null);
	const [revokeFailure, setRevokeFailure] = useState<RevokeFailure | null>(
		null,
	);
	const [unlinking, setUnlinking] = useState(false);
	const [unlinkError, setUnlinkError] = useState<string | null>(null);
	// Counts the flows this panel has seen start, so an unlink reply that
	// lands after a new link began does not bring back a notice that link
	// cleared.
	const flowsSeen = useRef(0);

	// Whenever the status shows the link gone the unlink question has nothing
	// left to ask, answered or not; and a link to another cloud gone or
	// replaced meanwhile is no longer what the link-over question speaks of.
	if (
		(view?.kind === "unlink" && status?.credential === "none") ||
		(view?.kind === "link_over" && status?.credential !== "other_cloud")
	) {
		setView({ kind: "status" });
	}

	// A flow's ending is an event told once: by the flow view when it is up,
	// by a notice on the status otherwise — and only for a flow this panel saw
	// running, so a reload never brings it back.
	const watched = useRef(new Set<string>());
	const flowViewUp = useRef(false);
	flowViewUp.current = view?.kind === "flow";
	const previousFlow = useRef(flow);
	useEffect(() => {
		const before = previousFlow.current;
		previousFlow.current = flow;
		if (!flow) {
			// Only a new snapshot empties the copy: the process restarted.
			if (before && isFlowRunning(before) && !flowViewUp.current) {
				setLastAttempt({ kind: "restarted" });
			}
			return;
		}
		if (isFlowRunning(flow)) {
			if (!watched.current.has(flow.id)) {
				watched.current.add(flow.id);
				flowsSeen.current++;
				// A new attempt: what was said about earlier ones is moot.
				setLastAttempt(null);
				setRevokeFailure(null);
			}
			return;
		}
		if (watched.current.delete(flow.id) && !flowViewUp.current) {
			setLastAttempt(hasEndingToTell(flow) ? { kind: "ended", flow } : null);
		}
	}, [flow]);

	const running = flow !== null && isFlowRunning(flow);
	const openFlow = () => setView({ kind: "flow", startOnOpen: !running });
	const onLink = () => {
		if (status?.credential === "other_cloud" && !running) {
			setView({ kind: "link_over" });
		} else {
			openFlow();
		}
	};
	const openUnlink = () => {
		setUnlinkError(null);
		setView({ kind: "unlink" });
	};
	// What was said in this opening is not carried to the next; an ending
	// that comes while the sheet is away is, as that is when it is news.
	const closeSheet = () => {
		setView(null);
		setLastAttempt(null);
		setRevokeFailure(null);
	};

	const machine = machineLabel(status?.machine_name);
	const unlink = async () => {
		const flowsBefore = flowsSeen.current;
		setUnlinking(true);
		setUnlinkError(null);
		try {
			const unlinked = await cloudLinkUnlink();
			setView((v) => (v?.kind === "unlink" ? { kind: "status" } : v));
			if (
				unlinked.was_linked &&
				unlinked.revoke_error &&
				flowsSeen.current === flowsBefore
			) {
				setRevokeFailure({
					// The reply's cloud, not the status's: a link to another cloud is
					// revoked there.
					cloudUrl: unlinked.cloud_url ?? status?.cloud_url ?? "",
					error: unlinked.revoke_error,
					machine,
				});
			}
		} catch (err) {
			// The connection went, not the server's answer: the unlink may well
			// have gone through, and pressing again would only ask for it twice.
			setUnlinkError(
				isConnectionLost(err)
					? UNLINK_NO_ANSWER
					: err instanceof Error
						? err.message
						: String(err),
			);
		} finally {
			setUnlinking(false);
		}
	};

	// Called by a flow view already gone, so it reads the refs, not this
	// render. A flow view up again shows its own start's error, and a running
	// flow makes the refusal moot.
	const onStartRefused = (error: string) => {
		const current = previousFlow.current;
		if (flowViewUp.current || (current && isFlowRunning(current))) return;
		setLastAttempt({ kind: "refused", error });
	};

	// The card outlives the buttons that remove themselves — Dismiss, and
	// Retry turning the row into a skeleton — so focus has somewhere inside
	// the sheet to go; on `body` it would slip out of the sheet's Tab trap.
	const cardRef = useRef<HTMLDivElement>(null);
	const dismissLastAttempt = () => {
		setLastAttempt(null);
		cardRef.current?.focus();
	};
	const retry = () => {
		link.retry();
		cardRef.current?.focus();
	};

	const machineState = machineRow({
		read,
		flow,
		startedHere: flow ? link.startedHere(flow.id) : false,
		connected,
		onLink,
		onContinue: openFlow,
		onUnlink: openUnlink,
		onRetry: retry,
	});
	// Drawn from `read`, as the machine row is: a failed read is not drawn
	// over a listing it can no longer vouch for.
	const instance = read.kind === "status" ? instanceRow(read.status) : null;

	return (
		<>
			<button
				type="button"
				onClick={() => setView({ kind: "status" })}
				aria-label="Cloud account"
				className="flex size-11 shrink-0 items-center justify-center rounded-lg text-th-text-secondary hover:bg-th-overlay-hover hover:text-th-text-primary"
			>
				<CloudIcon />
			</button>

			{view?.kind === "status" && (
				<Sheet title="Cloud account" onClose={closeSheet}>
					<div className="space-y-2 p-4">
						<p className="text-xs text-th-text-muted">{INTRO}</p>
						<div
							ref={cardRef}
							tabIndex={-1}
							className="space-y-1 rounded-lg border border-th-border bg-th-bg-secondary px-4 py-3 focus:outline-none"
						>
							<Row state={machineState}>
								{lastAttempt && (
									<LastAttemptNotice
										attempt={lastAttempt}
										cloudUrl={status?.cloud_url ?? ""}
										onDismiss={dismissLastAttempt}
									/>
								)}
								{revokeFailure && <RevokeNotice failure={revokeFailure} />}
							</Row>
							{instance && <Row state={instance} />}
						</div>
					</div>
				</Sheet>
			)}

			{view?.kind === "flow" && (
				<CloudLinkFlowSheet
					status={status}
					flow={flow}
					startOnOpen={view.startOnOpen}
					onFlow={link.applyFlow}
					onUnavailable={link.markUnavailable}
					onStartRefused={onStartRefused}
					onBack={() => setView({ kind: "status" })}
					onClose={closeSheet}
				/>
			)}

			{view?.kind === "unlink" && status && (
				<Sheet
					title="Unlink this machine?"
					onClose={closeSheet}
					dismissible={!unlinking}
					footer={
						<>
							<button
								type="button"
								onClick={() => setView({ kind: "status" })}
								disabled={unlinking}
								className={`${NEUTRAL_BUTTON} flex-1`}
							>
								Back
							</button>
							<button
								type="button"
								onClick={() => void unlink()}
								aria-busy={unlinking}
								disabled={unlinking || !connected}
								className={`${DANGER_BUTTON} flex-1`}
							>
								{unlinking && <Spinner variant="current" srText={null} />}
								Unlink
							</button>
						</>
					}
				>
					<div className="space-y-3 p-4 text-sm">
						<p className="text-th-text-secondary">
							{unlinkMessage(status, machine)}
						</p>
						{unlinkError && (
							<p role="alert" className="text-th-error">
								{unlinkError}
							</p>
						)}
					</div>
				</Sheet>
			)}

			{view?.kind === "link_over" && status && (
				<Sheet
					title={`Link to ${hostOf(status.cloud_url)} instead?`}
					onClose={closeSheet}
					footer={
						<>
							<button
								type="button"
								onClick={() => setView({ kind: "status" })}
								className={`${NEUTRAL_BUTTON} flex-1`}
							>
								Back
							</button>
							<button
								type="button"
								onClick={() => setView({ kind: "flow", startOnOpen: true })}
								disabled={!connected}
								className={`${DANGER_BUTTON} flex-1`}
							>
								Link
							</button>
						</>
					}
				>
					<p className="p-4 text-sm text-th-text-secondary">
						{linkOverMessage(status, machine)}
					</p>
				</Sheet>
			)}
		</>
	);
}

/** Whether a flow's ending needs telling beyond what the row already says. */
function hasEndingToTell(flow: CloudLinkFlow): boolean {
	return flow.phase === "failed" || !!flow.left_behind;
}

function unlinkMessage(status: CloudLinkStatus, machine: string): string {
	if (status.credential === "linked" && status.relay === "link_invalid") {
		return `This removes the link ${machine} no longer uses. Every Pockode on it keeps running, and their URLs keep working.`;
	}
	const list =
		status.credential === "other_cloud"
			? `the list at ${hostOf(status.other_cloud_url ?? "")}`
			: status.relay === "attached" && status.email
				? `${status.email}'s list`
				: "your cloud account's list";
	return `Every Pockode on ${machine} — this cluster, its nodes and other projects — leaves ${list}. They keep running, and their URLs keep working. You can link again at any time.`;
}

function linkOverMessage(status: CloudLinkStatus, machine: string): string {
	const other = hostOf(status.other_cloud_url ?? "");
	return `This machine stays linked to ${other} only until the new link is approved. Then every Pockode on ${machine} that uses ${other} leaves its list there, and the machine's entry stays in that account until you remove it on ${other}. To remove it cleanly, unlink first.`;
}

/** A row of the status card, with what it says under it. */
interface CardRow extends Partial<RowState> {
	/** Lets the title and subtitle wrap: an attention state cannot be cut. */
	wrap?: boolean;
	dimmed?: boolean;
	action?: ReactNode;
	notice?: ReactNode;
	/** Under the notice, in its own line: its actions. */
	noticeFooter?: ReactNode;
}

function Row({ state, children }: { state: CardRow; children?: ReactNode }) {
	const line = state.wrap ? "break-words" : "truncate";
	return (
		<div className={state.dimmed ? "opacity-70" : undefined}>
			<div className="flex min-h-11 items-center gap-3">
				<span
					className="flex h-5 w-4 shrink-0 items-center justify-center"
					aria-hidden="true"
				>
					{state.icon}
				</span>
				<div className="min-w-0 flex-1">
					{state.title === undefined ? (
						<>
							<span
								className="block h-4 w-32 animate-pulse rounded bg-th-bg-tertiary"
								aria-hidden="true"
							/>
							<span className="sr-only">Checking the cloud link</span>
						</>
					) : (
						<>
							<p className={`text-sm text-th-text-primary ${line}`}>
								{state.title}
							</p>
							<p className={`text-xs text-th-text-muted ${line}`}>
								{state.subtitle}
							</p>
						</>
					)}
				</div>
				{state.action}
			</div>
			{(state.notice || state.noticeFooter || children) && (
				<div className="space-y-2 pb-1 pl-7 text-xs text-th-text-secondary">
					{state.notice && <p className="break-words">{state.notice}</p>}
					{state.noticeFooter && (
						<div className="flex justify-end">{state.noticeFooter}</div>
					)}
					{children}
				</div>
			)}
		</div>
	);
}

interface MachineRowProps {
	read: CloudLinkRead;
	flow: CloudLinkFlow | null;
	startedHere: boolean;
	connected: boolean;
	onLink: () => void;
	onContinue: () => void;
	onUnlink: () => void;
	onRetry: () => void;
}

/**
 * The machine row: a running flow wins; otherwise `credential` decides, and
 * `relay` only refines a link to this cloud (docs/cloud-link-ui.md, "The
 * machine row").
 */
function machineRow(props: MachineRowProps): CardRow {
	const { read, flow, connected } = props;
	const primary = (label: string, onClick: () => void) => (
		<button
			type="button"
			onClick={onClick}
			disabled={!connected}
			className={`${PRIMARY_BUTTON} shrink-0`}
		>
			{label}
		</button>
	);
	const unlinkButton = (
		<button
			type="button"
			onClick={props.onUnlink}
			disabled={!connected}
			className={`${TEXT_BUTTON} text-th-error`}
		>
			Unlink
		</button>
	);

	switch (read.kind) {
		case "reading":
			return { icon: null };
		case "unavailable":
			return {
				icon: <InfoIcon className="text-th-text-muted" />,
				title: "Linking unavailable",
				subtitle: "This cluster can't store a cloud link",
				dimmed: true,
				wrap: true,
				notice: (
					<>
						The OS user running the cluster has no configuration directory — on
						Linux and macOS <code>$HOME</code> is unset, on Windows{" "}
						<code>%AppData%</code> — so there is nowhere to keep the link. Set
						it and restart the cluster.
					</>
				),
			};
		case "failed":
			// Never drawn as "Not linked": that guess would send the user into a
			// link that cannot fix what is wrong.
			return {
				icon: <AlertIcon className="text-th-error" />,
				title: "Couldn't read the link status",
				subtitle: "Retry, or reload",
				wrap: true,
				action: primary("Retry", props.onRetry),
				notice: read.error,
			};
	}

	const status = read.status;
	const machine = machineLabel(status.machine_name, true);

	if (flow && isFlowRunning(flow)) {
		return {
			icon: <Spinner srText={null} />,
			title: "Linking…",
			subtitle: <LinkingSubtitle flow={flow} startedHere={props.startedHere} />,
			action: primary("Continue", props.onContinue),
		};
	}

	if (status.credential === "none") {
		return {
			icon: <Dot className="text-th-text-muted" />,
			title: "Not linked",
			subtitle: machine,
			action: primary("Link", props.onLink),
		};
	}

	if (status.credential === "other_cloud") {
		const other = hostOf(status.other_cloud_url ?? "");
		return {
			icon: <InfoIcon className="text-th-text-muted" />,
			title: "Linked to another cloud",
			subtitle: other,
			wrap: true,
			action: primary("Link", props.onLink),
			notice: `This machine is linked to ${other}, a different cloud from the one this cluster uses (${hostOf(status.cloud_url)}). Every Pockode on it that uses ${other} is listed there.`,
			noticeFooter: unlinkButton,
		};
	}

	if (status.relay === "link_invalid") {
		return {
			icon: <AlertIcon className="text-th-warning" />,
			title: "Link no longer valid",
			subtitle: machine,
			wrap: true,
			action: primary("Link again", props.onLink),
			notice:
				"Your cloud account no longer accepts this machine's link — it was unlinked or revoked there, or the account was deleted. Every Pockode on this machine keeps running; none is listed until you link again.",
			noticeFooter: unlinkButton,
		};
	}

	// Green and the email only once the relay is attached: nothing else here
	// knows the account *now*, and a flow's email is history.
	if (status.relay === "attached" && status.email) {
		return {
			icon: <Dot className="text-th-success" filled />,
			title: `Linked as ${status.email}`,
			subtitle: machine,
			action: unlinkButton,
		};
	}
	return {
		icon: <Dot className="text-th-text-muted" filled />,
		title: "Linked",
		subtitle: machine,
		action: unlinkButton,
	};
}

/** Whether this cluster is listed; only while the machine is linked to this cloud. */
function instanceRow(status: CloudLinkStatus): CardRow | null {
	if (status.credential !== "linked" || status.relay === "link_invalid") {
		return null;
	}
	const line = instanceLine(status.relay, status.cloud_url);
	const open = <OpenCloud url={status.cloud_url} label="Open" />;
	switch (status.relay) {
		case "attached":
			return { ...line, action: open };
		case "not_attached":
			return {
				...line,
				wrap: true,
				notice:
					"Your cloud account didn't accept this cluster's entry — its data directory's name or path may contain characters the cloud doesn't allow, or the cloud had a problem. Restarting the cluster tries again; the cluster's log names the reason. Its nodes and other Pockode on this machine aren't affected.",
			};
		case "guest":
			return { ...line, wrap: true };
		case "disabled":
			// The machine's other instances may be listed even so.
			return {
				...line,
				action: open,
				notice: (
					<>
						This cluster runs with <code>-relay=false</code>, so it can't be
						listed. Other Pockode on this machine with remote access can.
					</>
				),
			};
		default:
			return line;
	}
}

function LinkingSubtitle({
	flow,
	startedHere,
}: {
	flow: CloudLinkFlow;
	startedHere: boolean;
}) {
	// Last, so a cut on a narrow phone takes this and keeps the countdown.
	const suffix = startedHere ? "" : " · started earlier";
	if (flow.phase === "waiting" && flow.expires_at) {
		return (
			<>
				<ExpiryText expiresAt={flow.expires_at} />
				{suffix}
			</>
		);
	}
	const line =
		flow.phase === "finishing" ? "Approved, saving the link…" : "Starting…";
	return (
		<>
			{line}
			{suffix}
		</>
	);
}

/**
 * How the last attempt this panel watched ended, told once in the past tense
 * (docs/cloud-link-ui.md, "Last attempt"). The row above shows the live state.
 */
function LastAttemptNotice({
	attempt,
	cloudUrl,
	onDismiss,
}: {
	attempt: LastAttempt;
	cloudUrl: string;
	onDismiss: () => void;
}) {
	let sentence = "";
	let details: string | undefined;
	let leftBehind = false;
	if (attempt.kind === "refused") {
		sentence = "Your last attempt to link couldn't start.";
		details = attempt.error;
	} else if (attempt.kind === "restarted") {
		sentence = "The cluster restarted, so your last attempt to link stopped.";
	} else {
		const { flow } = attempt;
		leftBehind = !!flow.left_behind;
		if (flow.phase === "failed") {
			switch (flow.failure?.reason) {
				case "expired":
					sentence = "Your last link code expired before it was approved.";
					break;
				case "declined":
					sentence = "Your last link was declined on the approval page.";
					break;
				default:
					sentence = "Your last attempt to link failed.";
					details = flow.failure?.detail;
			}
		}
	}

	return (
		<div className="space-y-1">
			<p className="break-words">
				{leftBehind ? (
					<Warning>
						{sentence && `${sentence} `}
						{leftBehindText(cloudUrl)}
					</Warning>
				) : (
					sentence
				)}
			</p>
			{details && <Details details={details} />}
			<div className="flex justify-end gap-2">
				{leftBehind && <OpenCloud url={cloudUrl} />}
				<button type="button" onClick={onDismiss} className={TEXT_BUTTON}>
					Dismiss
				</button>
			</div>
		</div>
	);
}

function RevokeNotice({ failure }: { failure: RevokeFailure }) {
	return (
		<div className="space-y-1">
			<p className="break-words">
				<Warning>
					Unlinked here, but {hostOf(failure.cloudUrl)} couldn't be told:{" "}
					{failure.error}. Remove {failure.machine} there so it isn't left in
					your list.
				</Warning>
			</p>
			<div className="flex justify-end">
				<OpenCloud url={failure.cloudUrl} />
			</div>
		</div>
	);
}
