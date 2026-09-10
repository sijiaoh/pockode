import { ConfirmDialog } from "@pockode/shared";
import { Trash2 } from "lucide-react";
import { useState } from "react";

interface Props {
	itemName: string;
	itemType: string;
	onDelete: () => void;
	confirmMessage?: string;
	ariaLabel?: string;
}

/**
 * Both halves of the reveal sit behind `pointer-fine`, so a coarse pointer gets
 * neither and the button simply stays visible — deleting is the only way to do
 * it from this row, so it can never depend on a hover that may not exist.
 * Opacity rather than `display` keeps it in the tab order, which is what
 * `group-focus-within` needs to hand it back to keyboard users.
 *
 * 36px of box with `touch-target` laying a 44px hit area over it, rather than a
 * 44px box: the box is what the row's icon rung says it is, and every row this
 * sits in is at least 44px tall, so the overlay stays inside the row instead of
 * reaching into the neighbouring row's Delete.
 *
 * Not overridable. The class was a prop until the reveal was fixed, and the one
 * caller that passed it used the opening to reintroduce a hover reveal that no
 * touch device could undo; a contract that can be swapped out at the call site
 * is not a contract. A row that needs a different delete affordance should say
 * so in props here, where every caller gets the fix.
 *
 * Requires a `.group` ancestor on the row (SidebarListItem, WorktreeItem).
 * See docs/responsive-ui.md.
 */
const deleteButtonClass =
	"touch-target flex items-center justify-center min-h-[36px] min-w-[36px] rounded-md text-th-text-secondary transition-all hover:text-th-error active:scale-95 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100";

function DeleteButton({
	itemName,
	itemType,
	onDelete,
	confirmMessage,
	ariaLabel,
}: Props) {
	const [showConfirm, setShowConfirm] = useState(false);

	const handleClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		setShowConfirm(true);
	};

	const handleConfirm = () => {
		setShowConfirm(false);
		onDelete();
	};

	return (
		<>
			<button
				type="button"
				onClick={handleClick}
				className={deleteButtonClass}
				aria-label={ariaLabel ?? `Delete ${itemName}`}
			>
				<Trash2 className="h-4 w-4" aria-hidden="true" />
			</button>

			{showConfirm && (
				<ConfirmDialog
					title={`Delete ${itemType}?`}
					message={
						confirmMessage ??
						`This will delete "${itemName}". This action cannot be undone.`
					}
					confirmLabel="Delete"
					variant="danger"
					onConfirm={handleConfirm}
					onCancel={() => setShowConfirm(false)}
				/>
			)}
		</>
	);
}

export default DeleteButton;
