import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useLockBodyScroll } from "../hooks/useLockBodyScroll.ts";
import { useIsExpanded } from "../hooks/useResponsive.ts";
import { useCloseWhenCovered } from "./CoveredSurface.tsx";

export interface SheetProps {
	title: string;
	onClose: () => void;
	/**
	 * Set false while an operation is in flight: the backdrop, Escape and the
	 * close button stop dismissing, so a slow relay link cannot leave the user
	 * unsure whether the operation was cancelled.
	 */
	dismissible?: boolean;
	/**
	 * Wraps the body and footer in a form, so Enter submits and a footer button
	 * can be type="submit".
	 */
	onSubmit?: (e: React.FormEvent) => void;
	footer?: ReactNode;
	children: ReactNode;
}

/**
 * Moves focus into the sheet on open and hands it back on close.
 *
 * Focus goes to the dialog element itself, not to the first focusable element.
 * First in the DOM is the close button, so the alternative opens every sheet
 * on "Close" — no information, and one stray Enter from dismissing it. The
 * dialog element is the one carrying `aria-labelledby`, so landing there reads
 * the title before anything else, and Tab then walks into the body.
 * `preventScroll` because `focus()` otherwise asks for a scroll into view, and
 * nothing should move behind a sheet that has just locked the page.
 *
 * The handback is skipped when the opener is gone from the document. Sheets
 * replace one another (a menu closes as a confirm sheet opens), and the row
 * that opened the first one can unmount with it; focusing a detached node is a
 * silent no-op that drops focus on the body.
 */
function useSheetFocus(ref: React.RefObject<HTMLElement | null>): void {
	useEffect(() => {
		const sheet = ref.current;
		if (!sheet) return;

		const opener = document.activeElement;
		sheet.focus({ preventScroll: true });

		return () => {
			if (opener instanceof HTMLElement && opener.isConnected) {
				opener.focus({ preventScroll: true });
			}
		};
	}, [ref]);
}

const FOCUSABLE_SELECTOR = [
	"a[href]",
	"button:not([disabled])",
	"input:not([disabled])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	'[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Bottom drawer below the expanded tier, centered modal at and above it.
 *
 * That one decision is read once, from `useIsExpanded`, and drives both the
 * class strings and the drag handle. It deliberately has no `lg:` twin: a
 * width prefix saying the same thing would be a second copy of the threshold,
 * and the two would drift the moment either is edited.
 *
 * The body scrolls between a fixed header and footer; it has no padding of its
 * own so a sheet can put full-bleed rows in it.
 *
 * Both layouts cap the content box against the viewport. Without a cap the
 * column is as tall as its content, so the body's overflow never has anything
 * to scroll and a long list (dozens of branches) runs off both edges of a
 * centered modal, taking the footer with it.
 */
export function Sheet({
	title,
	onClose,
	dismissible = true,
	onSubmit,
	footer,
	children,
}: SheetProps) {
	const isExpanded = useIsExpanded();
	const titleId = useId();
	const asDrawer = !isExpanded;
	const sheetRef = useRef<HTMLDivElement>(null);

	// Claims the press, as `ConfirmDialog` does. A surface below a sheet that
	// also reads Escape as its own dismissal sees the key only if nothing above
	// it took it, and one genuinely sits below: the chat's answer panel, which
	// listens on `window` precisely so that it is asked after every `document`
	// listener has had the press (docs/answering-ui.md §4, "Who owns Escape").
	// Without the claim, one press puts away both the sheet and a panel holding
	// answers the user was part-way through.
	//
	// Claimed even while refusing, which is the one place the claim and the
	// close come apart. The backdrop is drawn whether or not it dismisses, so a
	// press meant for a sheet mid-operation is swallowed rather than handed
	// down; a key that fell through instead would answer "cancel this" by
	// putting away the surface behind, which is the sheet refusing on its own
	// behalf and consenting on someone else's.
	//
	// `stopPropagation` rather than `preventDefault`: either marks the press,
	// and this is the one the other shared overlay already uses. It does not
	// silence a sibling listener on `document` itself, which is why a dialog
	// raised inside a sheet still closes together with it.
	useEffect(() => {
		const handleEscape = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.stopPropagation();
			if (!dismissible) return;
			onClose();
		};

		document.addEventListener("keydown", handleEscape);
		return () => document.removeEventListener("keydown", handleEscape);
	}, [onClose, dismissible]);

	useLockBodyScroll();
	useSheetFocus(sheetRef);
	// This sheet is portalled to the body, so nothing its opener does to put
	// itself away reaches it. Closing with the surface it was raised from is
	// the sheet's own job, and the only one it can be (CoveredSurface).
	useCloseWhenCovered(onClose);

	/**
	 * Keeps Tab inside the sheet. The backdrop already swallows every tap meant
	 * for the page behind, so Tab would otherwise be the one way left to reach
	 * and drive a surface the sheet is covering.
	 */
	const handleTab = (e: React.KeyboardEvent) => {
		if (e.key !== "Tab") return;
		const sheet = sheetRef.current;
		if (!sheet) return;
		// A sheet can hold a dialog that portals out of its DOM yet stays a React
		// child, so that dialog's keys bubble into this handler anyway; the
		// force-push confirmation in `web`'s `SyncSheet` does exactly that. The
		// trap answers only for its own subtree — whatever is drawn on top of
		// the sheet owns its own keys.
		if (e.target instanceof Node && !sheet.contains(e.target)) return;

		const stops = Array.from(
			sheet.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
		);
		// A sheet whose every control is disabled still traps: focus stays on the
		// box rather than escaping to the page behind.
		if (stops.length === 0) {
			e.preventDefault();
			return;
		}

		const first = stops[0];
		const last = stops[stops.length - 1];
		const active = document.activeElement;

		if (e.shiftKey) {
			// The box sits ahead of every stop, so backwards from it wraps too.
			if (active === first || active === sheet) {
				e.preventDefault();
				last.focus();
			}
		} else if (active === last) {
			e.preventDefault();
			first.focus();
		}
	};

	const body = (
		<>
			<div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
			{footer && (
				<div className="flex shrink-0 gap-3 border-t border-th-border p-4">
					{footer}
				</div>
			)}
		</>
	);

	return createPortal(
		<div
			// outline-none: this element takes focus on open only to announce the
			// sheet, and a ring around the whole viewport would read as a control.
			className={`fixed inset-0 z-50 flex justify-center bg-th-bg-overlay outline-none ${
				asDrawer ? "items-end" : "items-center"
			}`}
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
			ref={sheetRef}
			tabIndex={-1}
			onKeyDown={handleTab}
		>
			{/* Backdrop */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: Overlay backdrop - Escape key handled in useEffect */}
			<div
				className="absolute inset-0"
				onClick={dismissible ? onClose : undefined}
			/>

			{/* Content */}
			<div
				className={`relative flex w-full flex-col bg-th-bg-secondary shadow-xl ${
					asDrawer
						? "max-h-[90dvh] rounded-t-2xl"
						: "mx-4 max-h-[85dvh] max-w-md rounded-xl"
				}`}
			>
				{/* Drag handle - drawer only */}
				{asDrawer && (
					<div className="flex shrink-0 justify-center pt-3">
						<div className="h-1 w-10 rounded-full bg-th-text-muted/30" />
					</div>
				)}

				{/* Header. The close button is 36px of box with a 44px hit area laid
				    over it (touch-target) and negative margins that let it eat into
				    the header's padding, so a thumb gets its 44px without the header
				    growing to fit a 44px box. `touch-target` is a project `@utility`,
				    so every stylesheet compiling this package has to declare it — an
				    undeclared one keeps the class and emits nothing, leaving the
				    button at 36px in that project only. Pinned by
				    web/tests/responsiveTokens.test.ts. */}
				<div className="flex shrink-0 items-center justify-between border-b border-th-border px-4 py-3">
					<h2
						id={titleId}
						className="min-w-0 truncate text-base font-bold text-th-text-primary"
					>
						{title}
					</h2>
					<button
						type="button"
						onClick={onClose}
						disabled={!dismissible}
						className="touch-target -my-1.5 -mr-1 flex size-9 shrink-0 items-center justify-center rounded text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-primary disabled:cursor-not-allowed disabled:opacity-50"
						aria-label="Close"
					>
						{/* Inline rather than an icon component: shared's peer deps are
						    React/ReactDOM/Zustand only, and an icon library pulled in here
						    would land in both frontends' bundles. */}
						<svg
							className="h-5 w-5"
							fill="none"
							stroke="currentColor"
							strokeWidth={2}
							strokeLinecap="round"
							strokeLinejoin="round"
							viewBox="0 0 24 24"
							aria-hidden="true"
						>
							<path d="M18 6 6 18M6 6l12 12" />
						</svg>
					</button>
				</div>

				{onSubmit ? (
					<form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
						{body}
					</form>
				) : (
					body
				)}
			</div>
		</div>,
		document.body,
	);
}
