import { Loader2 } from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
import BottomActionBar from "./BottomActionBar";

/**
 * Where a detail — a file, a diff, a file of a commit — draws its actions. The
 * chat's composer is under every one of them (`overlayKeepsComposer`), so the
 * bottom of the screen is shared:
 *
 * - `top` — wide, the bottom is the composer's alone and the actions join the
 *   detail's toolbar.
 * - `bottom` — narrow, they stand above the composer, in the thumb's reach.
 * - `hidden` — narrow, while the composer holds a soft keyboard: three bars
 *   and a keyboard leave the page no room to read. The selection bar is not
 *   one of them — inserting code is what typing wants most.
 *
 * The toolbar's view toggles are not actions and stay at the top at every
 * width: they are about how the page is read, which a keyboard does not change.
 */
export type DetailActionsPlacement = "top" | "bottom" | "hidden";

export function detailActionsPlacement(
	isExpanded: boolean,
	keyboardUp: boolean,
): DetailActionsPlacement {
	if (isExpanded) return "top";
	return keyboardUp ? "hidden" : "bottom";
}

/**
 * A detail's actions, by the slot each one takes; the slots are laid out the
 * same on every screen (docs/file-actions-ui.md).
 */
export interface DetailActions {
	/**
	 * The one action that takes something away or leaves: farthest from the
	 * primary, the corner pressed all day.
	 */
	leading?: ReactNode;
	/** Icon actions, between the two. */
	utilities?: ReactNode;
	/** The screen's one `PrimaryActionButton`, last. */
	primary?: ReactNode;
}

type ActionsEnd = "top" | "bottom";

// Read by the buttons whose box depends on the row they are in, so a screen
// writes each of its actions once for both ends.
const ActionsEndContext = createContext<ActionsEnd>("bottom");

function hasActions({ leading, utilities, primary }: DetailActions) {
	return Boolean(leading || utilities || primary);
}

function ActionGroup({
	actions: { leading, utilities, primary },
	end,
}: {
	actions: DetailActions;
	end: ActionsEnd;
}) {
	// At the bottom the row is the bar's whole width: a primary takes what is
	// left of it, and without one the rest goes right, into the thumb's reach.
	// In the toolbar the spacer has already pushed the group to the end, and
	// the group keeps whole: the spacer is what gives way.
	const trailing =
		end === "bottom" ? (primary ? "min-w-0 flex-1" : "ml-auto") : "";
	return (
		<ActionsEndContext.Provider value={end}>
			<div
				className={`flex items-center gap-3 ${end === "top" ? "shrink-0" : ""}`}
			>
				{leading}
				{(utilities || primary) && (
					<div
						className={`flex items-center gap-1 pointer-coarse:gap-2 ${trailing}`}
					>
						{utilities}
						{primary}
					</div>
				)}
			</div>
		</ActionsEndContext.Provider>
	);
}

interface ViewToolbarProps {
	/** `‹ k / n ›`, where the page is one of a sequence. */
	nav?: ReactNode;
	/**
	 * View toggles, in the order Source · Wrap · Whitespace · Split. Each is
	 * absent where it would change nothing, not drawn disabled.
	 */
	toggles?: ReactNode;
	actions?: DetailActions;
	actionsAt: DetailActionsPlacement;
	/** Lines under the row that belong to it, such as a primary's hint. */
	below?: ReactNode;
}

/**
 * The row under a detail's header: how the page is read on the left and right,
 * and at `top` what to do with it after a divider. Not drawn at all when this
 * width leaves it nothing to hold — an empty row would only cost a line of the
 * page.
 */
export function ViewToolbar({
	nav,
	toggles,
	actions = {},
	actionsAt,
	below,
}: ViewToolbarProps) {
	const withActions = actionsAt === "top" && hasActions(actions);
	if (!nav && !toggles && !withActions) return null;
	return (
		<>
			<div className="flex min-h-[44px] shrink-0 items-center gap-1 border-b border-th-border px-2 pointer-coarse:gap-2">
				{nav}
				{/* The part that gives way. */}
				<div className="min-w-0 flex-1" />
				{toggles}
				{withActions && (
					<>
						{toggles && (
							<div
								aria-hidden="true"
								className="mx-1 h-5 w-px shrink-0 bg-th-border"
							/>
						)}
						<ActionGroup actions={actions} end="top" />
					</>
				)}
			</div>
			{withActions && below}
		</>
	);
}

interface DetailActionBottomBarProps {
	actions: DetailActions;
	actionsAt: DetailActionsPlacement;
	/** Above the buttons: a line under them is the first a keyboard covers. */
	above?: ReactNode;
}

/** The same actions as `ViewToolbar`'s, where `actionsAt` is `bottom`. */
export function DetailActionBottomBar({
	actions,
	actionsAt,
	above,
}: DetailActionBottomBarProps) {
	if (actionsAt !== "bottom" || !hasActions(actions)) return null;
	return (
		<BottomActionBar>
			{above}
			<ActionGroup actions={actions} end="bottom" />
		</BottomActionBar>
	);
}

const textActionButtonBase =
	"flex items-center justify-center gap-1.5 rounded-lg text-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent disabled:cursor-not-allowed disabled:opacity-50";

// Sized to each row: the bottom bar's are a thumb's whatever the pointer; the
// toolbar's follow the pointer like the icons beside them, and keep whole,
// since the toolbar's spacer is what gives way.
const textActionButtonBottom = `${textActionButtonBase} min-h-[44px] px-4`;
const textActionButtonTop = `${textActionButtonBase} min-h-9 shrink-0 whitespace-nowrap px-3 pointer-coarse:min-h-11`;

/**
 * The box of a text action — the primary, or a leading one such as Discard
 * file — in the row at `end`. Colour is the caller's: the accent for the
 * primary, `bg-th-bg-tertiary` with the error colour or the primary text
 * colour for a leading one.
 */
function textActionButtonClass(end: ActionsEnd) {
	return end === "top" ? textActionButtonTop : textActionButtonBottom;
}

function useActionsEnd() {
	return useContext(ActionsEndContext);
}

interface PrimaryActionButtonProps {
	label: ReactNode;
	onClick: () => void;
	disabled?: boolean;
	/** What the button says while its action runs, beside a spinner. */
	pendingLabel?: ReactNode;
	"aria-describedby"?: string;
}

/**
 * The screen's one primary action, accent-filled and last in its row. At the
 * bottom it takes the rest of the row.
 */
export function PrimaryActionButton({
	label,
	onClick,
	disabled = false,
	pendingLabel,
	"aria-describedby": describedBy,
}: PrimaryActionButtonProps) {
	const end = useActionsEnd();
	const busy = pendingLabel != null;
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			aria-busy={busy || undefined}
			aria-describedby={describedBy}
			className={`${textActionButtonClass(end)} ${end === "bottom" ? "min-w-0 flex-1" : ""} bg-th-accent font-medium text-th-accent-text`}
		>
			{busy ? (
				<>
					<Loader2
						className="h-4 w-4 shrink-0 animate-spin"
						aria-hidden="true"
					/>
					{pendingLabel}
				</>
			) : (
				label
			)}
		</button>
	);
}

interface LeadingTextActionButtonProps {
	children: ReactNode;
	onClick: () => void;
	disabled?: boolean;
	/** `error` for an action that takes something away; it is confirmed first. */
	tone?: "neutral" | "error";
	"aria-label"?: string;
}

/**
 * The leading action written as text, for the other outcome of the decision a
 * text primary makes: Discard file beside Stage, Unstage beside Next. At the
 * bottom it yields the row to the primary rather than squeezing it.
 */
export function LeadingTextActionButton({
	children,
	onClick,
	disabled = false,
	tone = "neutral",
	"aria-label": label,
}: LeadingTextActionButtonProps) {
	const end = useActionsEnd();
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			aria-label={label}
			className={`${textActionButtonClass(end)} ${end === "bottom" ? "max-w-[50%] shrink-0" : ""} bg-th-bg-tertiary ${tone === "error" ? "text-th-error" : "text-th-text-primary"}`}
		>
			{children}
		</button>
	);
}
