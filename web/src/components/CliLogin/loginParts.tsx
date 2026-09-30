import { ChevronRight, Clock, ExternalLink } from "lucide-react";
import { type MouseEvent, useEffect, useState } from "react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { CollapsibleBody } from "../ui";

export const primaryButtonClass =
	"inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-th-accent px-4 text-sm text-th-accent-text transition-colors hover:bg-th-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent disabled:cursor-not-allowed disabled:opacity-50";

export const secondaryButtonClass =
	"inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-th-bg-tertiary px-4 text-sm text-th-text-primary transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent disabled:cursor-not-allowed disabled:opacity-50";

/** A card's text action, on its own row; the caller gives the colour. */
export const cardTextButtonClass =
	"inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent disabled:cursor-not-allowed disabled:opacity-50";

/** Beside a value it acts on: smaller under a mouse, still a thumb's width. */
export const textButtonClass =
	"inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm text-th-accent hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent pointer-coarse:min-h-11";

/** The current time, ticking once a second. */
export function useNow(): number {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);

	return now;
}

export function formatMinutes(ms: number): string {
	const total = Math.ceil(ms / 1000);
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * "Expires in m:ss", drawn from the server's `expires_at`. The server is the
 * clock: at zero this only stops counting, and the server ends the flow. Not a
 * live region — it would talk every second.
 */
export function ExpiryLine({ expiresAt }: { expiresAt: string }) {
	const now = useNow();
	// Never below 0: at the deadline the server ends the flow, not this.
	const remaining = Math.max(0, Date.parse(expiresAt) - now);
	const lastMinute = remaining <= 60_000;

	return (
		<p
			className={`flex items-center gap-1.5 text-xs ${
				lastMinute ? "text-th-text-primary" : "text-th-text-muted"
			}`}
		>
			{lastMinute && (
				<Clock className="h-3.5 w-3.5 text-th-warning" aria-hidden="true" />
			)}
			Expires in {formatMinutes(remaining)}
		</p>
	);
}

/**
 * The host and path, so the user sees which page they are about to type a
 * code into; "…" when a query was left out.
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
 * "Open sign-in page" and "Copy link", with the page named under them. Copy
 * link is for doing the browser half on another device; when it fails, the
 * link is shown whole so it can be copied by hand.
 */
export function SignInLink({
	url,
	onOpen,
}: {
	url: string;
	/** Runs as the link opens, before the user has left. */
	onOpen?: (e: MouseEvent<HTMLAnchorElement>) => void;
}) {
	const { state: copyState, copy } = useCopyToClipboard();

	return (
		<div className="space-y-1.5">
			<div className="flex flex-wrap items-center gap-2">
				<a
					href={url}
					target="_blank"
					rel="noopener noreferrer"
					onClick={onOpen}
					className={`${primaryButtonClass} flex-1`}
				>
					Open sign-in page
					<ExternalLink className="h-4 w-4" aria-hidden="true" />
				</a>
				<button
					type="button"
					onClick={() => copy(url)}
					className={textButtonClass}
				>
					{copyState === "copied" ? "Link copied" : "Copy link"}
				</button>
			</div>
			{copyState === "failed" ? (
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

export function Step({
	number,
	title,
	children,
}: {
	number: number;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<section className="space-y-3">
			<h3 className="flex items-baseline gap-2 text-sm font-medium text-th-text-primary">
				<span className="text-th-text-muted">{number}</span>
				{title}
			</h3>
			<div className="space-y-3 pl-5">{children}</div>
		</section>
	);
}

/** A collapsed "Details" with a command's own output, for a failure's reader. */
export function Details({
	details,
	defaultOpen = false,
}: {
	details: string;
	defaultOpen?: boolean;
}) {
	const [expanded, setExpanded] = useState(defaultOpen);
	return (
		<div>
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
				className="-ml-1 inline-flex min-h-9 items-center gap-1 rounded-md px-1 text-xs text-th-text-muted hover:text-th-text-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent pointer-coarse:min-h-11"
			>
				<ChevronRight
					className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-90" : ""}`}
					aria-hidden="true"
				/>
				Details
			</button>
			<CollapsibleBody expanded={expanded}>
				<pre className="mt-1 whitespace-pre-wrap break-words rounded-md bg-th-bg-tertiary p-3 font-mono text-xs text-th-text-secondary">
					{details}
				</pre>
			</CollapsibleBody>
		</div>
	);
}
