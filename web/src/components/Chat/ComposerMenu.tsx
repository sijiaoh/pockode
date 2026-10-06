import type { LucideIcon } from "lucide-react";
import { type KeyboardEvent, type RefObject, useEffect } from "react";
import MenuRow from "../common/MenuRow";

export interface ComposerMenuItem {
	id: string;
	icon: LucideIcon;
	label: string;
	onSelect: () => void;
}

interface Props {
	id: string;
	items: ComposerMenuItem[];
	/** Runs a row's action; the bar closes the menu around it. */
	onSelect: (item: ComposerMenuItem) => void;
	menuRef: RefObject<HTMLDivElement | null>;
	/** Opened from the keyboard, so focus goes to the first row. */
	focusOnOpen: boolean;
	/** Tab leaves the menu: forward to the draft, backward to the `+`. */
	onTabOut: (backward: boolean) => void;
}

/** Moves focus to a row: the first, the last, or one step from the focused one. */
export function focusMenuItem(
	menu: HTMLElement | null,
	which: "first" | "last" | 1 | -1,
) {
	if (!menu) return;
	const rows = Array.from(
		menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
	);
	if (rows.length === 0) return;
	let index: number;
	if (which === "first") index = 0;
	else if (which === "last") index = rows.length - 1;
	else {
		const current = rows.indexOf(document.activeElement as HTMLElement);
		index = (current + which + rows.length) % rows.length;
	}
	rows[index].focus();
}

/**
 * The composer's `+` menu, hung over the button that opens it at every width.
 * A sheet would cover the whole screen on a phone for a handful of rows.
 *
 * Only the rows and their keys live here. Escape, the outside click and the
 * page cover are the bar's, because the bar also decides what each of them
 * does with focus and with the command palette this menu takes turns with.
 *
 * A press on a row keeps focus where it was (`onMouseDown`), for the same
 * reason the `+` does: the textarea losing it drops the on-screen keyboard.
 */
function ComposerMenu({
	id,
	items,
	onSelect,
	menuRef,
	focusOnOpen,
	onTabOut,
}: Props) {
	// biome-ignore lint/correctness/useExhaustiveDependencies: only on open
	useEffect(() => {
		if (focusOnOpen) focusMenuItem(menuRef.current, "first");
	}, []);

	const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				focusMenuItem(menuRef.current, 1);
				break;
			case "ArrowUp":
				e.preventDefault();
				focusMenuItem(menuRef.current, -1);
				break;
			case "Home":
				e.preventDefault();
				focusMenuItem(menuRef.current, "first");
				break;
			case "End":
				e.preventDefault();
				focusMenuItem(menuRef.current, "last");
				break;
			case "Tab":
				// Moved by hand rather than left to the browser: closing unmounts
				// the focused row before the Tab lands, and some browsers then
				// restart from the top of the page.
				e.preventDefault();
				onTabOut(e.shiftKey);
				break;
		}
	};

	return (
		<div
			ref={menuRef}
			id={id}
			role="menu"
			aria-label="Add"
			onKeyDown={handleKeyDown}
			onMouseDown={(e) => e.preventDefault()}
			className="absolute bottom-full left-0 z-50 mb-1 min-w-56 overflow-hidden rounded-lg border border-th-border bg-th-bg-secondary py-1 shadow-lg"
		>
			{items.map((item) => (
				<MenuRow
					key={item.id}
					role="menuitem"
					icon={item.icon}
					label={item.label}
					onClick={() => onSelect(item)}
				/>
			))}
		</div>
	);
}

export default ComposerMenu;
