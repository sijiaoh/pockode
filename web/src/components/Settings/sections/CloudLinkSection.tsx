import { ConfirmDialog } from "@pockode/shared";
import { AlertTriangle, ExternalLink, Info } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
	type CloudLinkRead,
	useCloudLinkSubscription,
} from "../../../hooks/useCloudLinkSubscription";
import { isRPCTimeout, useWSStore } from "../../../lib/wsStore";
import {
	type CloudLinkFlow,
	type CloudLinkStatus,
	isFlowRunning,
} from "../../../types/cloudLink";
import {
	cardTextButtonClass,
	primaryButtonClass,
	textButtonClass,
	useExpiryText,
} from "../../CliLogin/loginParts";
import CloudLinkSheet from "../../CloudLink/CloudLinkSheet";
import {
	hostOf,
	instanceLine,
	leftBehindText,
	machineLabel,
} from "../../CloudLink/cloudLinkText";
import { Spinner } from "../../ui";
import CliRow, {
	CliRowNotice,
	Dot,
	type CliRowState as RowState,
} from "./CliRow";

/** How a flow this page watched running ended while the sheet was closed. */
type LastAttempt =
	| { kind: "ended"; flow: CloudLinkFlow }
	| { kind: "restarted" };

/** An unlink the cloud could not be told about. */
interface RevokeFailure {
	cloudUrl: string;
	error: string;
	machine: string;
}

const UNLINK_NO_ANSWER =
	"No answer yet. The card will show whether it went through.";

/**
 * This machine's link to the cloud account: whether it is linked, whether
 * this Pockode is in the account's list, and Link and Unlink
 * (docs/cloud-link-ui.md). The link is the OS user's, so it covers every
 * Pockode on the machine, and the intro says so before anything else.
 */
export default function CloudLinkSection() {
	const link = useCloudLinkSubscription();
	// The card draws `read`; what is already open — the sheet, a dialog —
	// goes on with the last status read, through a read that failed since.
	const { read, status, flow } = link;
	const connected = useWSStore((s) => s.status === "connected");
	const cloudLinkUnlink = useWSStore((s) => s.actions.cloudLinkUnlink);

	const [sheet, setSheet] = useState<{ startOnOpen: boolean } | null>(null);
	const [confirm, setConfirm] = useState<"unlink" | "link_over" | null>(null);
	const [lastAttempt, setLastAttempt] = useState<LastAttempt | null>(null);
	const [revokeFailure, setRevokeFailure] = useState<RevokeFailure | null>(
		null,
	);
	// Bumped on every close of the sheet or a dialog; see the focus effect.
	const [closings, setClosings] = useState(0);

	// Whenever the status shows the link gone the dialog has nothing left to
	// do, whether or not its request has answered; and a link to another cloud
	// gone or replaced meanwhile is no longer what the dialog speaks of.
	if (
		(confirm === "unlink" && status?.credential === "none") ||
		(confirm === "link_over" && status?.credential !== "other_cloud")
	) {
		setConfirm(null);
		setClosings((n) => n + 1);
	}

	// A flow's ending is an event told once: by the sheet when it is up, by a
	// notice on the card otherwise — and only for a flow this page saw running,
	// so a reload never brings it back.
	const watched = useRef(new Set<string>());
	const sheetOpen = useRef(false);
	sheetOpen.current = sheet !== null;
	const previousFlow = useRef(flow);
	useEffect(() => {
		const before = previousFlow.current;
		previousFlow.current = flow;
		if (!flow) {
			// Only a new snapshot empties the copy: the process restarted.
			if (before && isFlowRunning(before) && !sheetOpen.current) {
				setLastAttempt({ kind: "restarted" });
			}
			return;
		}
		if (isFlowRunning(flow)) {
			if (!watched.current.has(flow.id)) {
				watched.current.add(flow.id);
				// A new attempt: what was said about earlier ones is moot.
				setLastAttempt(null);
				setRevokeFailure(null);
			}
			return;
		}
		if (watched.current.delete(flow.id) && !sheetOpen.current) {
			setLastAttempt(hasEndingToTell(flow) ? { kind: "ended", flow } : null);
		}
	}, [flow]);

	// The card outlives the notices and rows that held the buttons, so focus
	// has somewhere to go when a sheet or dialog closes after its opener went
	// with them — the notice's Unlink, once the link it was about is gone. A
	// button React kept in place (Link relabelled Continue) gets focus back as
	// usual.
	const cardRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (closings === 0) return;
		if (!document.activeElement || document.activeElement === document.body) {
			cardRef.current?.focus();
		}
	}, [closings]);
	const closeSheet = () => {
		setSheet(null);
		setClosings((n) => n + 1);
	};
	const closeConfirm = () => {
		setConfirm(null);
		setClosings((n) => n + 1);
	};

	const openSheet = () => {
		setSheet({ startOnOpen: !(flow && isFlowRunning(flow)) });
	};
	const onLink = () => {
		if (
			status?.credential === "other_cloud" &&
			!(flow && isFlowRunning(flow))
		) {
			setConfirm("link_over");
		} else {
			openSheet();
		}
	};

	const machine = machineLabel(status?.machine_name);
	const unlink = async () => {
		try {
			const unlinked = await cloudLinkUnlink();
			closeConfirm();
			if (unlinked.was_linked && unlinked.revoke_error) {
				setRevokeFailure({
					// The reply's cloud, not the status's: a link to another cloud is
					// revoked there.
					cloudUrl: unlinked.cloud_url ?? status?.cloud_url ?? "",
					error: unlinked.revoke_error,
					machine,
				});
			}
		} catch (err) {
			// Our own clock gave up, not the server: the unlink may well have gone
			// through, and pressing again would only ask for it twice.
			if (isRPCTimeout(err)) throw new Error(UNLINK_NO_ANSWER);
			throw err;
		}
	};

	const machineState = machineRow({
		read,
		flow,
		startedHere: flow ? link.startedHere(flow.id) : false,
		connected,
		onLink,
		onContinue: openSheet,
		onUnlink: () => setConfirm("unlink"),
		onRetry: link.retry,
	});
	const { notice: machineNotice, ...machineLine } = machineState;
	// Drawn from `read`, as the machine row is: a failed read is not drawn
	// over a listing it can no longer vouch for.
	const instance = read.kind === "status" ? instanceRow(read.status) : null;

	const dismissLastAttempt = () => {
		setLastAttempt(null);
		cardRef.current?.focus();
	};

	return (
		<div className="space-y-2">
			<p className="text-xs text-th-text-muted">
				Open every Pockode on this machine — this one, other projects and
				cluster nodes — from your cloud account.
			</p>
			<div
				ref={cardRef}
				tabIndex={-1}
				className="space-y-1 rounded-lg border border-th-border bg-th-bg-secondary px-4 py-3 focus:outline-none"
			>
				<CliRow
					{...machineLine}
					loadingLabel="Checking the cloud link"
					notice={
						<>
							<CliRowNotice {...machineNotice} />
							{lastAttempt && (
								<LastAttemptNotice
									attempt={lastAttempt}
									cloudUrl={status?.cloud_url ?? ""}
									onDismiss={dismissLastAttempt}
								/>
							)}
							{revokeFailure && <RevokeNotice failure={revokeFailure} />}
						</>
					}
				/>
				{instance && <InstanceRow state={instance} />}
			</div>

			{sheet && (
				<CloudLinkSheet
					status={status}
					flow={flow}
					startOnOpen={sheet.startOnOpen}
					onFlow={link.applyFlow}
					onUnavailable={link.markUnavailable}
					onClose={closeSheet}
				/>
			)}

			{confirm === "unlink" && status && (
				<ConfirmDialog
					title="Unlink this machine?"
					message={unlinkMessage(status, machine)}
					confirmLabel="Unlink"
					cancelLabel="Cancel"
					variant="danger"
					onConfirm={unlink}
					onCancel={closeConfirm}
				/>
			)}

			{confirm === "link_over" && status && (
				<ConfirmDialog
					title={`Link to ${hostOf(status.cloud_url)} instead?`}
					message={linkOverMessage(status, machine)}
					confirmLabel="Link"
					cancelLabel="Cancel"
					variant="danger"
					onConfirm={() => {
						setConfirm(null);
						openSheet();
					}}
					onCancel={closeConfirm}
				/>
			)}
		</div>
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
	return `Every Pockode on ${machine} — this one, other projects and cluster nodes — leaves ${list}. They keep running, and their URLs keep working. You can link again at any time.`;
}

function linkOverMessage(status: CloudLinkStatus, machine: string): string {
	const other = hostOf(status.other_cloud_url ?? "");
	return `This machine stays linked to ${other} only until the new link is approved. Then every Pockode on ${machine} that uses ${other} leaves its list there, and the machine's entry stays in that account until you remove it on ${other}. To remove it cleanly, unlink first.`;
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
function machineRow(props: MachineRowProps): RowState {
	const { read, flow, connected } = props;
	const primary = (label: string, onClick: () => void) => (
		<button
			type="button"
			onClick={onClick}
			disabled={!connected}
			className={primaryButtonClass}
		>
			{label}
		</button>
	);
	const unlinkButton = (
		<button
			type="button"
			onClick={props.onUnlink}
			disabled={!connected}
			className={`${cardTextButtonClass} text-th-error`}
		>
			Unlink
		</button>
	);

	switch (read.kind) {
		case "reading":
			return { title: undefined };
		case "unavailable":
			return {
				icon: <Info className="h-4 w-4 text-th-text-muted" />,
				title: "Linking unavailable",
				subtitle: "This Pockode can't store a cloud link",
				dimmed: true,
				wrap: true,
				notice: {
					body: (
						<>
							The OS user running Pockode has no configuration directory — on
							Linux and macOS <code>$HOME</code> is unset, on Windows{" "}
							<code>%AppData%</code> — so there is nowhere to keep the link. Set
							it and restart Pockode.
						</>
					),
				},
			};
		case "failed":
			// Never drawn as "Not linked": that guess would send the user into a
			// link that cannot fix what is wrong.
			return {
				icon: <AlertTriangle className="h-4 w-4 text-th-error" />,
				title: "Couldn't read the link status",
				subtitle: "Retry, or reload",
				wrap: true,
				action: primary("Retry", props.onRetry),
				notice: { body: read.error },
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
			icon: <Info className="h-4 w-4 text-th-text-muted" />,
			title: "Linked to another cloud",
			subtitle: other,
			wrap: true,
			action: primary("Link", props.onLink),
			notice: {
				body: `This machine is linked to ${other}, a different cloud from the one this Pockode uses (${hostOf(status.cloud_url)}). Every Pockode on it that uses ${other} is listed there.`,
				footer: unlinkButton,
			},
		};
	}

	if (status.relay === "link_invalid") {
		return {
			icon: <AlertTriangle className="h-4 w-4 text-th-warning" />,
			title: "Link no longer valid",
			subtitle: machine,
			wrap: true,
			action: primary("Link again", props.onLink),
			notice: {
				body: "Your cloud account no longer accepts this machine's link — it was unlinked or revoked there, or the account was deleted. Every Pockode on this machine keeps running; none is listed until you link again.",
				footer: unlinkButton,
			},
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

/** Whether this Pockode is listed; only while the machine is linked to this cloud. */
function instanceRow(status: CloudLinkStatus): RowState | null {
	if (status.credential !== "linked" || status.relay === "link_invalid") {
		return null;
	}
	const line = instanceLine(status.relay, status.cloud_url);
	const open = (
		<a
			href={status.cloud_url}
			target="_blank"
			rel="noopener noreferrer"
			className={textButtonClass}
		>
			Open
			<ExternalLink className="h-4 w-4" aria-hidden="true" />
		</a>
	);
	switch (status.relay) {
		case "attached":
			return { ...line, action: open };
		case "not_attached":
			return {
				...line,
				wrap: true,
				notice: {
					body: "Your cloud account didn't accept this Pockode's entry — its folder name or path may contain characters the cloud doesn't allow, or the cloud had a problem. Restarting Pockode tries again; the server log names the reason. Other Pockode on this machine aren't affected.",
				},
			};
		case "guest":
			return { ...line, wrap: true };
		case "disabled":
			// The machine's other instances may be listed even so.
			return {
				...line,
				action: open,
				notice: {
					body: (
						<>
							This Pockode runs with <code>-relay=false</code>, so it can't be
							listed. Other Pockode on this machine with remote access can.
						</>
					),
				},
			};
		default:
			return line;
	}
}

function InstanceRow({ state }: { state: RowState }) {
	const { notice, ...row } = state;
	return <CliRow {...row} notice={<CliRowNotice {...notice} />} />;
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
		return <ExpiryText expiresAt={flow.expires_at} suffix={suffix} />;
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

function ExpiryText({
	expiresAt,
	suffix,
}: {
	expiresAt: string;
	suffix: string;
}) {
	const { text } = useExpiryText(expiresAt);
	return (
		<>
			{text}
			{suffix}
		</>
	);
}

function OpenCloud({ url }: { url: string }) {
	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			className={textButtonClass}
		>
			Open {hostOf(url)}
			<ExternalLink className="h-4 w-4" aria-hidden="true" />
		</a>
	);
}

function Warning({ children }: { children: ReactNode }) {
	return (
		<span className="flex gap-1.5 text-th-text-primary">
			<AlertTriangle
				className="mt-px h-3.5 w-3.5 shrink-0 text-th-warning"
				aria-hidden="true"
			/>
			<span>{children}</span>
		</span>
	);
}

/**
 * How the last attempt this page watched ended, told once in the past tense
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
	const dismiss = (
		<button type="button" onClick={onDismiss} className={textButtonClass}>
			Dismiss
		</button>
	);
	if (attempt.kind === "restarted") {
		return (
			<CliRowNotice
				body="Pockode restarted, so your last attempt to link stopped."
				footer={dismiss}
			/>
		);
	}

	const { flow } = attempt;
	let sentence = "";
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
		}
	}
	const details =
		flow.phase === "failed" && flow.failure?.reason === "other"
			? flow.failure.detail
			: undefined;

	if (!flow.left_behind) {
		return (
			<CliRowNotice
				body={sentence}
				details={details}
				detailsKey={flow.id}
				footer={dismiss}
			/>
		);
	}
	return (
		<CliRowNotice
			body={
				<Warning>
					{sentence && `${sentence} `}
					{leftBehindText(cloudUrl)}
				</Warning>
			}
			details={details}
			detailsKey={flow.id}
			footer={
				<>
					<OpenCloud url={cloudUrl} />
					{dismiss}
				</>
			}
		/>
	);
}

function RevokeNotice({ failure }: { failure: RevokeFailure }) {
	return (
		<CliRowNotice
			body={
				<Warning>
					Unlinked here, but {hostOf(failure.cloudUrl)} couldn't be told:{" "}
					{failure.error}. Remove {failure.machine} there so it isn't left in
					your list.
				</Warning>
			}
			footer={<OpenCloud url={failure.cloudUrl} />}
		/>
	);
}
