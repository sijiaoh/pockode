import { GlobeLock } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { Refusals, RefusedHost } from "../../lib/pageHosts";
import { TEXT_BUTTON } from "./ClampedContent";

/**
 * How long Load and Open ignore presses after what they name changes: a host
 * that arrives a moment before the tap would otherwise be allowed unread. The
 * browsers' own permission prompts hold their buttons the same way.
 */
export const PRESS_HOLD_MS = 500;

/** Up to this many hosts are named in the strip; past it, behind Review. */
const SHOWN_HOSTS = 3;

const BUTTON = `${TEXT_BUTTON} -my-1 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-th-accent`;

/**
 * Wraps a press so that it does nothing within `PRESS_HOLD_MS` of `key`
 * changing, `key` being what the control's press would act on — or of the
 * strip being shown again, which is a change too.
 */
function useHeldPress(key: string) {
	const changedAt = useRef(0);
	const seen = useRef<string | null>(null);
	if (seen.current !== key) {
		seen.current = key;
		changedAt.current = performance.now();
	}
	return (press: () => void) => () => {
		if (performance.now() - changedAt.current < PRESS_HOLD_MS) return;
		press();
	};
}

function Hosts({ hosts }: { hosts: readonly RefusedHost[] }) {
	return hosts.map((entry, index) => (
		<span key={entry.host}>
			{index > 0 && ", "}
			{entry.allowable ? (
				<span className="text-th-text-primary">{entry.host}</span>
			) : (
				<span className="text-th-text-muted">
					{entry.host}{" "}
					{entry.inPolicy ? "(allowed, still refused)" : "(can't be allowed)"}
				</span>
			)}
		</span>
	));
}

function Line({
	children,
	action,
}: {
	children: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="flex items-start gap-2">
			<p className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</p>
			{action}
		</div>
	);
}

interface Props {
	/** What the document now in the frame was refused. */
	refusals: Refusals;
	/** What the reader has allowed for this page, now. */
	allowed: ReadonlySet<string>;
	/** The latest link the page asked to open that the app could not open itself. */
	link: { host: string } | null;
	/** The page navigated its frame away and was refused; null host for a URL with none. */
	left: { host: string | null } | null;
	/** Allow these hosts and reload the page under them. */
	onLoad: (hosts: string[]) => void;
	/** Reload the page under the policy it has now. */
	onReload: () => void;
	onOpenLink: () => void;
}

/**
 * The band between a page's chrome and its frame that says what the page was
 * refused, and the one place it can be allowed
 * (docs/page-external-hosts-ui.md#what-the-reader-sees). Nothing at all while
 * there is nothing to say. Never drawn inside the frame: nothing the page draws
 * can allow anything, however much it looks like this.
 *
 * Mounted only while the page is shown, so that showing it again announces it
 * again.
 */
export function PageHostsStrip({
	refusals,
	allowed,
	link,
	left,
	onLoad,
	onReload,
	onOpenLink,
}: Props) {
	const [expanded, setExpanded] = useState(false);
	const listId = useId();

	// Refused but allowed since this document was drawn — elsewhere, or by a
	// Load this frame was not the one to make.
	const stale = refusals.hosts
		.filter((entry) => entry.allowable && allowed.has(entry.host))
		.map((entry) => entry.host);
	const pending = refusals.hosts.filter(
		(entry) => !(entry.allowable && allowed.has(entry.host)),
	);
	const loadable = pending
		.filter((entry) => entry.allowable)
		.map((entry) => entry.host);
	const collapsible = pending.length > SHOWN_HOSTS;
	const open = collapsible && expanded;
	const showPending = pending.length > 0;
	const showStale = stale.length > 0 && loadable.length === 0;
	const hasContent = left !== null || showPending || showStale || link !== null;

	// Keyed on the list's being opened too, which puts Load all under the
	// reader's finger as much as a new host does.
	const holdLoad = useHeldPress(
		`${open} ${pending.map((entry) => entry.host).join(" ")}`,
	);
	const holdOpen = useHeldPress(link?.host ?? "");

	// Announced once, the first time there is something to say: a page that
	// keeps retrying would otherwise talk over everything. Set a moment after
	// the region is in place, or a reader would not hear it change.
	const [announced, setAnnounced] = useState(false);
	useEffect(() => {
		if (!hasContent || announced) return;
		const timer = setTimeout(() => setAnnounced(true), 100);
		return () => clearTimeout(timer);
	}, [hasContent, announced]);

	const loadButton = (label: string, ariaLabel: string) => (
		<button
			type="button"
			aria-label={ariaLabel}
			onClick={holdLoad(() => onLoad(loadable))}
			className={BUTTON}
		>
			{label}
		</button>
	);
	const reloadButton = (ariaLabel: string) => (
		<button
			type="button"
			aria-label={ariaLabel}
			onClick={onReload}
			className={BUTTON}
		>
			Reload
		</button>
	);

	let body: ReactNode = null;
	if (left !== null) {
		// The document the rest was about is gone.
		body = (
			<Line action={reloadButton("Reload the page")}>
				Page left
				{left.host && (
					<>
						{" · "}
						<span className="text-th-text-primary">{left.host}</span>
					</>
				)}
			</Line>
		);
	} else if (hasContent) {
		body = (
			<>
				{showPending &&
					(collapsible ? (
						<>
							<Line
								action={
									<button
										type="button"
										aria-expanded={open}
										aria-controls={open ? listId : undefined}
										onClick={() => setExpanded(!open)}
										className={BUTTON}
									>
										{open ? "Hide" : "Review"}
									</button>
								}
							>
								Not loaded · <Hosts hosts={pending.slice(0, 2)} /> and{" "}
								{pending.length - 2} more
							</Line>
							{open && (
								<div id={listId} className="mt-1.5 flex flex-col gap-1.5">
									<ul className="max-h-48 overflow-y-auto [overflow-wrap:anywhere]">
										{pending.map((entry) => (
											<li key={entry.host}>
												<Hosts hosts={[entry]} />
											</li>
										))}
									</ul>
									{refusals.overflow && (
										<p>More hosts were refused and aren't listed.</p>
									)}
									{loadable.length > 0 && (
										<Line
											action={loadButton(
												`Load all ${loadable.length}`,
												`Load all ${loadable.length} hosts and reload the page`,
											)}
										>
											Loading reloads the page.
										</Line>
									)}
								</div>
							)}
						</>
					) : (
						<Line
							action={
								loadable.length > 0 &&
								loadButton(
									"Load",
									`Load ${loadable.join(", ")} and reload the page`,
								)
							}
						>
							Not loaded · <Hosts hosts={pending} />
						</Line>
					))}
				{showStale && (
					<Line
						action={reloadButton(`Reload the page to load ${stale.join(", ")}`)}
					>
						Allowed ·{" "}
						<span className="text-th-text-primary">{stale.join(", ")}</span>
					</Line>
				)}
				{link && (
					<Line
						action={
							<button
								type="button"
								aria-label={`Open link to ${link.host}`}
								onClick={holdOpen(onOpenLink)}
								className={BUTTON}
							>
								Open
							</button>
						}
					>
						Link not opened ·{" "}
						<span className="text-th-text-primary">{link.host}</span>
					</Line>
				)}
			</>
		);
	}

	return (
		<>
			<div aria-live="polite" className="sr-only">
				{announced && hasContent ? "Some of this page wasn't loaded." : ""}
			</div>
			{body && (
				// biome-ignore lint/a11y/useSemanticElements: a fieldset is a form's; this is a band of text with a button
				<div
					role="group"
					aria-label="Hosts not loaded"
					className="flex items-start gap-2 border-b border-th-border bg-th-bg-secondary px-3 py-1.5 text-xs text-th-text-secondary"
				>
					<GlobeLock
						className="mt-0.5 size-3.5 shrink-0 text-th-text-muted"
						aria-hidden="true"
					/>
					<div className="flex min-w-0 flex-1 flex-col gap-1.5">{body}</div>
				</div>
			)}
		</>
	);
}
