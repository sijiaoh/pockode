import { Loader2, Minus, Plus, Undo2 } from "lucide-react";
import { memo } from "react";
import { type FileStatus, GIT_STATUS_INFO } from "../../types/git";
import { splitPath } from "../../utils/path";
import SidebarListItem from "../common/SidebarListItem";
import { iconButtonClass } from "./iconButtonClass";

interface Props {
	file: FileStatus;
	staged: boolean;
	onSelect: (path: string, staged: boolean) => void;
	onToggleStage: (path: string, staged: boolean) => void;
	/** Absent on staged rows: unstage first, which the button beside it does. */
	onDiscard?: (file: FileStatus) => void;
	isActive: boolean;
	isToggling?: boolean;
	isDiscarding?: boolean;
}

const DiffFileItem = memo(function DiffFileItem({
	file,
	staged,
	onSelect,
	onToggleStage,
	onDiscard,
	isActive,
	isToggling,
	isDiscarding,
}: Props) {
	const statusInfo = GIT_STATUS_INFO[file.status] ?? GIT_STATUS_INFO["?"];
	const { fileName, directory } = splitPath(file.path);

	const Icon = staged ? Minus : Plus;
	const actionLabel = staged ? "Unstage file" : "Stage file";
	// Either action leaves the other with a stale idea of the file.
	const isBusy = Boolean(isToggling || isDiscarding);

	return (
		<SidebarListItem
			title={fileName}
			subtitle={directory}
			isActive={isActive}
			onSelect={() => onSelect(file.path, staged)}
			ariaLabel={`View ${statusInfo.label.toLowerCase()} file: ${file.path}`}
			leftSlot={
				<span
					className={`shrink-0 self-start mt-0.5 text-xs ${statusInfo.color}`}
					title={statusInfo.label}
				>
					{file.status}
				</span>
			}
			actions={
				<>
					{/*
					 * Inboard of the stage button on purpose: staging is frequent and
					 * benign, so it keeps the rightmost, most thumb-reachable slot,
					 * while the destructive action sits where it is harder to hit.
					 */}
					{onDiscard && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onDiscard(file);
							}}
							disabled={isBusy}
							className={iconButtonClass(isBusy)}
							aria-label={
								file.status === "?" ? "Delete file" : "Discard changes"
							}
						>
							{isDiscarding ? (
								<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
							) : (
								<Undo2 className="h-4 w-4" aria-hidden="true" />
							)}
						</button>
					)}
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							onToggleStage(file.path, staged);
						}}
						disabled={isBusy}
						className={iconButtonClass(isBusy)}
						aria-label={actionLabel}
					>
						{isToggling ? (
							<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
						) : (
							<Icon className="h-4 w-4" aria-hidden="true" />
						)}
					</button>
				</>
			}
		/>
	);
});

export default DiffFileItem;
