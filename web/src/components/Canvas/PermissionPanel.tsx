import { ChevronDown, Lock } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef } from "react";
import type { ResolvedPermission } from "../../lib/permissionRequestStore";
import type { PermissionRequest } from "../../types/message";
import type { PromptError } from "../Chat/MessageItem";
import {
	type PermissionChoice,
	PermissionRequestItem,
	UnreadablePermissionItem,
} from "../Chat/PermissionRequestItem";
import { ARM_MS } from "../Chat/SendStopSlot";
import { PERMISSION_SEND_REFUSED, RefusalFlash } from "./PermissionBanner";

interface Props {
	/**
	 * On the screen. False while it is kept, hidden, under chat view or a page
	 * over the session: nothing in it is reachable, and it hears no key.
	 */
	active: boolean;
	/** The turn's permission blockers, oldest first, however they stand. */
	permissions: ResolvedPermission[];
	isCodex: boolean;
	onRespond: (request: PermissionRequest, choice: PermissionChoice) => void;
	promptError?: PromptError;
	onOpenFile?: (path: string) => void;
	/** Hide, Back, Escape and the backdrop: never a denial. */
	onCollapse: () => void;
	/** Asked as the panel appears: whether it takes focus. */
	takeFocus: () => boolean;
	/**
	 * Told, as the panel goes, whether focus was in it — before its DOM is
	 * removed, which drops that focus to the body.
	 */
	onUnmount: (hadFocus: boolean) => void;
	/** A send was refused a moment ago: the sentence takes the title's place. */
	refused: boolean;
	attempt: number;
}

/**
 * The canvas's permission panel (docs/canvas-ui.md §10.1): every pending
 * request as the chat's own card, modal over the canvas's column and nothing
 * else — the header, the strips, the input and Stop stay lit.
 *
 * Drawn by `CanvasView`, which decides when it is up (§10.2) and registers it
 * as a layer; this is the panel as it is while it is.
 */
export function PermissionPanel({
	active,
	permissions,
	isCodex,
	onRespond,
	promptError,
	onOpenFile,
	onCollapse,
	takeFocus,
	onUnmount,
	refused,
	attempt,
}: Props) {
	const titleId = useId();
	const rootRef = useRef<HTMLElement>(null);
	const backdropRef = useRef<HTMLDivElement>(null);

	const pending = permissions.filter((p) => p.status === "pending").length;
	const settled = permissions.length - pending;
	// On Claude a denial ends the turn: every other request is about to
	// expire, and an answer to one would only be refused.
	const endingTurn = !isCodex && permissions.some((p) => p.status === "denied");
	const title =
		pending > 1 ? `${pending} permission requests` : "Permission request";

	// Onto the panel itself, never onto a button: a key already on its way
	// must not land on Allow.
	// biome-ignore lint/correctness/useExhaustiveDependencies: on appearing only
	useLayoutEffect(() => {
		if (takeFocus()) rootRef.current?.focus({ preventScroll: true });
	}, []);

	const unmountRef = useRef(onUnmount);
	useLayoutEffect(() => {
		unmountRef.current = onUnmount;
	});
	useLayoutEffect(() => {
		const root = rootRef.current;
		return () =>
			unmountRef.current(root?.contains(document.activeElement) ?? false);
	}, []);

	// Read when a key or a press comes, not when they are listened for: the
	// host passes an inline close.
	const collapseRef = useRef(onCollapse);
	useLayoutEffect(() => {
		collapseRef.current = onCollapse;
	});

	// Read on `window`, after every `document` listener: a sheet drawn over
	// this claims the key there, and one press must not put both away
	// (docs/answering-ui.md#who-owns-escape).
	useEffect(() => {
		if (!active) return;
		const handleEscape = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			collapseRef.current();
		};
		window.addEventListener("keydown", handleEscape);
		return () => window.removeEventListener("keydown", handleEscape);
	}, [active]);

	// On `window` for the reason the answer panel gives: a dropdown dismissed
	// by a click on this backdrop claims it on `document` first. Not for
	// `ARM_MS` after appearing — it comes up by itself, possibly under a
	// finger already on its way to the page.
	useEffect(() => {
		if (!active) return;
		const appearedAt = performance.now();
		const handleClick = (e: MouseEvent) => {
			if (e.target !== backdropRef.current) return;
			if (performance.now() - appearedAt < ARM_MS) return;
			collapseRef.current();
		};
		window.addEventListener("click", handleClick);
		return () => window.removeEventListener("click", handleClick);
	}, [active]);

	// A settled card remounts closed, and a keyboard answer's focus goes with
	// the pressed button: it moves on — to the panel at once, and to the next
	// pending card's first button once that is armed. A pointer press never
	// focused the button, and is left alone.
	const carryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(carryTimer.current), []);
	const respond = (request: PermissionRequest, choice: PermissionChoice) => {
		const root = rootRef.current;
		const active = document.activeElement;
		const hadFocus =
			active instanceof HTMLButtonElement && root?.contains(active);
		onRespond(request, choice);
		if (!hadFocus || !root) return;
		root.focus({ preventScroll: true });
		clearTimeout(carryTimer.current);
		carryTimer.current = setTimeout(() => {
			if (document.activeElement !== root) return;
			root
				.querySelector<HTMLButtonElement>('[data-armed="true"] button')
				?.focus();
		}, ARM_MS + 50);
	};

	return (
		<div
			inert={!active}
			className={`absolute inset-0 z-10 flex items-center justify-center${active ? "" : " invisible"}`}
		>
			<div
				ref={backdropRef}
				data-testid="permission-panel-backdrop"
				className="absolute inset-0 bg-th-bg-overlay"
				aria-hidden="true"
			/>
			{/* Without `aria-modal`, as the answer panel: the header, the strips
			    and the input it leaves lit are still there to reach. */}
			<section
				ref={rootRef}
				role="dialog"
				tabIndex={-1}
				aria-labelledby={titleId}
				className="relative mx-4 flex max-h-[85%] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-th-bg-secondary shadow-xl outline-none"
			>
				<div className="relative flex shrink-0 items-center gap-2 border-b border-th-border px-4 py-3">
					<Lock
						className="size-4 shrink-0 text-th-warning"
						aria-hidden="true"
					/>
					{/* The dialog keeps its name while the sentence stands in for the
					    title: the title stays in the DOM, visually hidden. In place, so
					    no line pushes the cards' buttons down. */}
					<h2
						id={titleId}
						className={
							refused
								? "sr-only"
								: "min-w-0 flex-1 truncate text-base font-bold text-th-text-primary"
						}
					>
						{title}
					</h2>
					{refused && (
						<span
							aria-hidden="true"
							className="min-w-0 flex-1 truncate text-base font-bold text-th-text-primary"
						>
							{PERMISSION_SEND_REFUSED}
						</span>
					)}
					{/* Not an ✕: beside Deny it would read as refusing, and this
					    refuses nothing — it puts the panel away to the banner. */}
					<button
						type="button"
						onClick={onCollapse}
						className="touch-target flex h-7 shrink-0 items-center gap-1 rounded-md border border-th-border px-3 text-xs text-th-text-primary transition-colors hover:bg-th-overlay-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
					>
						Hide
						<ChevronDown className="size-4" aria-hidden="true" />
					</button>
					<RefusalFlash attempt={attempt} />
					<output className="sr-only">
						{refused ? PERMISSION_SEND_REFUSED : ""}
					</output>
				</div>
				<div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-y-contain p-4">
					{permissions.map((permission) =>
						permission.request ? (
							// Keyed by status too, so a settled card mounts afresh and
							// starts closed.
							<PermissionRequestItem
								key={`${permission.requestId}:${permission.status}`}
								request={permission.request}
								status={permission.status}
								reason={permission.reason}
								isCodex={isCodex}
								onRespond={respond}
								onOpenFile={onOpenFile}
								error={
									promptError?.requestId === permission.requestId &&
									permission.status === "pending"
										? promptError.message
										: undefined
								}
								// Every settling re-arms the cards still pending, from
								// whichever surface it came.
								armKey={`${permission.requestId}:${settled}`}
								endingTurn={endingTurn}
							/>
						) : (
							<UnreadablePermissionItem
								key={permission.requestId}
								loading={!permission.unreadable}
							/>
						),
					)}
				</div>
			</section>
		</div>
	);
}
