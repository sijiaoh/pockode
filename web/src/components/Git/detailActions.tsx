import type { ReactNode } from "react";
import { BottomActionBar } from "../ui";

/**
 * Where a Git detail draws its action bar. The chat's composer is under every
 * detail (`overlayKeepsComposer`), so the bottom of the screen is shared:
 *
 * - `top` — wide, the bottom is the composer's alone and the actions join the
 *   detail's toolbar.
 * - `bottom` — narrow, they stand above the composer, in the thumb's reach.
 * - `hidden` — narrow, while the composer holds a soft keyboard: three bars
 *   and a keyboard leave the page no room to read. The selection bar is not
 *   one of them — inserting code is what typing wants most.
 *
 * Decided once, by `GitWorkspace`, for every detail that has a bar.
 */
export type DetailActionsPlacement = "top" | "bottom" | "hidden";

export function detailActionsPlacement(
	isExpanded: boolean,
	keyboardUp: boolean,
): DetailActionsPlacement {
	if (isExpanded) return "top";
	return keyboardUp ? "hidden" : "bottom";
}

interface DetailActionBarProps {
	/** The end of the page this one is written at. */
	end: "top" | "bottom";
	placement: DetailActionsPlacement;
	children: ReactNode;
}

/**
 * A detail's action bar, written at both ends of the page and drawn at the
 * one `placement` names. For a detail whose toolbar is the bar itself; the
 * review has a toolbar of its own and puts its actions into it.
 */
export function DetailActionBar({
	end,
	placement,
	children,
}: DetailActionBarProps) {
	if (placement !== end) return null;
	if (end === "bottom") return <BottomActionBar>{children}</BottomActionBar>;
	return (
		<div className="shrink-0 border-b border-th-border px-2 py-1">
			{children}
		</div>
	);
}
