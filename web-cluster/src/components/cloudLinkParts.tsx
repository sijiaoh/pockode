import {
	type CloudLinkRelay,
	hostOf,
	Spinner,
	useSecondsUntil,
} from "@pockode/shared";
import { type ReactNode, useState } from "react";
import { TEXT_BUTTON } from "./buttons";

// The pieces the Cloud sheet's views share: icons, the words that name the
// machine and this cluster, and the small blocks every phase is built from.
// The behaviour and the words follow docs/cloud-link-ui.md; where web says
// "this Pockode" this panel says "this cluster", the Pockode it is.

function Svg({
	className,
	children,
}: {
	className: string;
	children: ReactNode;
}) {
	return (
		<svg
			className={className}
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			viewBox="0 0 24 24"
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

export function CloudIcon({ className = "h-5 w-5" }: { className?: string }) {
	return (
		<Svg className={className}>
			<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
		</Svg>
	);
}

export function AlertIcon({
	className,
	size = "h-4 w-4",
}: {
	className: string;
	size?: string;
}) {
	return (
		<Svg className={`shrink-0 ${size} ${className}`}>
			<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
			<path d="M12 9v4" />
			<path d="M12 17h.01" />
		</Svg>
	);
}

export function InfoIcon({
	className,
	size = "h-4 w-4",
}: {
	className: string;
	size?: string;
}) {
	return (
		<Svg className={`shrink-0 ${size} ${className}`}>
			<circle cx="12" cy="12" r="10" />
			<path d="M12 16v-4" />
			<path d="M12 8h.01" />
		</Svg>
	);
}

export function CheckIcon({
	className,
	size = "h-4 w-4",
}: {
	className: string;
	size?: string;
}) {
	return (
		<Svg className={`shrink-0 ${size} ${className}`}>
			<circle cx="12" cy="12" r="10" />
			<path d="m9 12 2 2 4-4" />
		</Svg>
	);
}

export function CrossIcon({
	className,
	size = "h-4 w-4",
}: {
	className: string;
	size?: string;
}) {
	return (
		<Svg className={`shrink-0 ${size} ${className}`}>
			<circle cx="12" cy="12" r="10" />
			<path d="m15 9-6 6" />
			<path d="m9 9 6 6" />
		</Svg>
	);
}

export function ExternalIcon() {
	return (
		<Svg className="h-4 w-4 shrink-0">
			<path d="M15 3h6v6" />
			<path d="M10 14 21 3" />
			<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
		</Svg>
	);
}

/** The machine's status mark: hollow when not linked, filled when linked. */
export function Dot({
	className,
	filled = false,
}: {
	className: string;
	filled?: boolean;
}) {
	return (
		<span
			className={`block h-2.5 w-2.5 rounded-full border-2 border-current ${filled ? "bg-current" : ""} ${className}`}
			aria-hidden="true"
		/>
	);
}

/**
 * The machine a link or an unlink acts on, as the copy names it; `start` for
 * a line that begins with it.
 */
export function machineLabel(
	machineName: string | undefined,
	start = false,
): string {
	return machineName || (start ? "This machine" : "this machine");
}

export const INTRO =
	"Open every Pockode on this machine — this cluster, its nodes and other projects — from your cloud account.";

export const SCOPE_SENTENCE =
	"Every Pockode on this machine — this cluster, its nodes and other projects — will be listed in the account you approve with.";

/** `left_behind`: an approved link nothing on this machine uses. */
export function leftBehindText(cloudUrl: string): string {
	return `An extra entry for this machine may be left in your cloud account. Remove it on ${hostOf(cloudUrl)}.`;
}

export interface RowState {
	icon: ReactNode;
	title: string;
	subtitle: ReactNode;
}

/**
 * Whether this cluster is in the account's list, while the machine is linked
 * to this cloud: the status view's instance row, and the line under the
 * flow's *Linked* (docs/cloud-link-ui.md, "The instance row").
 */
export function instanceLine(
	relay: Exclude<CloudLinkRelay, "link_invalid">,
	cloudUrl: string,
): RowState {
	switch (relay) {
		case "attached":
			return {
				icon: <CheckIcon className="text-th-success" />,
				title: "This cluster is listed",
				subtitle: hostOf(cloudUrl),
			};
		case "pending":
			// No duration is promised: a relay that cannot reach the cloud can
			// leave it here, and the server is the clock.
			return {
				icon: <Spinner srText={null} />,
				title: "Adding this cluster…",
				subtitle: "Waiting for the cloud to list it",
			};
		case "not_attached":
			return {
				icon: <AlertIcon className="text-th-warning" />,
				title: "This cluster isn't listed",
				subtitle: "Linking again won't fix this",
			};
		case "guest":
			return {
				icon: <AlertIcon className="text-th-warning" />,
				title: "This cluster isn't listed",
				subtitle: "The cluster's log says why",
			};
		case "disabled":
			return {
				icon: <InfoIcon className="text-th-text-muted" />,
				title: "This cluster isn't listed",
				subtitle: "Remote access is off",
			};
	}
}

function formatMinutes(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	return `${minutes}:${(seconds % 60).toString().padStart(2, "0")}`;
}

/**
 * "Expires in m:ss", drawn from the server's `expires_at`. The server is the
 * clock: at zero this only stops counting, and the server ends the flow.
 */
export function useExpiryText(expiresAt: string): {
	text: string;
	lastMinute: boolean;
} {
	const seconds = useSecondsUntil(Date.parse(expiresAt));
	return {
		text: `Expires in ${formatMinutes(seconds)}`,
		lastMinute: seconds <= 60,
	};
}

export function ExpiryText({ expiresAt }: { expiresAt: string }) {
	return <>{useExpiryText(expiresAt).text}</>;
}

/**
 * The expiry under the waiting line, the colour on its icon in the last
 * minute. Not a live region: it would talk every second.
 */
export function ExpiryLine({ expiresAt }: { expiresAt: string }) {
	const { text, lastMinute } = useExpiryText(expiresAt);
	return (
		<p
			className={`flex items-center gap-1.5 text-xs ${
				lastMinute ? "text-th-text-primary" : "text-th-text-muted"
			}`}
		>
			{lastMinute && (
				<Svg className="h-3.5 w-3.5 shrink-0 text-th-warning">
					<circle cx="12" cy="12" r="10" />
					<path d="M12 6v6l4 2" />
				</Svg>
			)}
			{text}
		</p>
	);
}

export function SpinnerLine({ children }: { children: ReactNode }) {
	return (
		<p className="flex items-center gap-2 text-sm text-th-text-secondary">
			<Spinner srText={null} />
			{children}
		</p>
	);
}

/** A collapsed "Details" with the server's own words, for a failure's reader. */
export function Details({ details }: { details: string }) {
	const [expanded, setExpanded] = useState(false);
	return (
		<div>
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
				className="-ml-1 inline-flex min-h-9 items-center gap-1 rounded-md px-1 text-xs text-th-text-muted hover:text-th-text-secondary pointer-coarse:min-h-11"
			>
				<Svg className={`h-3.5 w-3.5 ${expanded ? "rotate-90" : ""}`}>
					<path d="m9 18 6-6-6-6" />
				</Svg>
				Details
			</button>
			{expanded && (
				<pre className="mt-1 whitespace-pre-wrap break-words rounded-md bg-th-bg-tertiary p-3 font-mono text-xs text-th-text-secondary">
					{details}
				</pre>
			)}
		</div>
	);
}

/** How a flow ended: an icon, a title that says what happened, and what to do. */
export function Outcome({
	icon,
	title,
	children,
	details,
}: {
	icon: ReactNode;
	title: string;
	children?: ReactNode;
	details?: string;
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
			{details && <Details details={details} />}
		</div>
	);
}

/** A warning inside a notice: the icon carries the colour, not the words. */
export function Warning({ children }: { children: ReactNode }) {
	return (
		<span className="flex gap-1.5 text-th-text-primary">
			<AlertIcon className="mt-0.5 text-th-warning" />
			<span>{children}</span>
		</span>
	);
}

export function OpenCloud({
	url,
	label = `Open ${hostOf(url)}`,
}: {
	url: string;
	label?: string;
}) {
	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			className={TEXT_BUTTON}
		>
			{label}
			<ExternalIcon />
		</a>
	);
}
