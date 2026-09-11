import { MoreHorizontal } from "lucide-react";
import { iconButtonClass } from "../ui/iconButtonClass";

interface Props {
	/** Which side the bubble sits on, so the row lines up under it. */
	side: "user" | "assistant";
	onOpenMenu: () => void;
}

/**
 * The thin action row under a chat bubble.
 *
 * A `…` rather than a fork icon: a branch glyph repeated under forty bubbles
 * reads as decoration, while `…` is already this app's answer to "everything
 * this row can do beyond the one thing tapping it does". Not a long press on
 * the bubble either — bubbles are the one place users select and copy text, and
 * long press is how a phone starts a selection.
 */
function MessageActions({ side, onOpenMenu }: Props) {
	return (
		<div
			className={`flex ${side === "user" ? "justify-end" : "justify-start"}`}
		>
			<button
				type="button"
				onClick={onOpenMenu}
				aria-label="Message actions"
				className={iconButtonClass()}
			>
				<MoreHorizontal className="size-4" aria-hidden="true" />
			</button>
		</div>
	);
}

export default MessageActions;
