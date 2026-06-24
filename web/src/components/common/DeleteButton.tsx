import { ConfirmDialog } from "@pockode/shared";
import { Trash2 } from "lucide-react";
import { useState } from "react";

interface Props {
	itemName: string;
	itemType: string;
	onDelete: () => void;
	confirmMessage?: string;
	ariaLabel?: string;
	className?: string;
}

function DeleteButton({
	itemName,
	itemType,
	onDelete,
	confirmMessage,
	ariaLabel,
	className = "flex items-center justify-center min-h-[36px] min-w-[36px] rounded-md text-th-text-secondary transition-all hover:text-th-error active:scale-95 sm:hidden sm:group-hover:flex",
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
				className={className}
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
