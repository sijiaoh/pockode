import { Loader2, Minus, Plus } from "lucide-react";
import { type FileStatus, GIT_STATUS_INFO } from "../../types/git";
import { splitPath } from "../../utils/path";
import SidebarListItem from "../common/SidebarListItem";

interface Props {
	file: FileStatus;
	staged: boolean;
	onSelect: () => void;
	onToggleStage: () => void;
	isActive: boolean;
	isToggling?: boolean;
}

function DiffFileItem({
	file,
	staged,
	onSelect,
	onToggleStage,
	isActive,
	isToggling,
}: Props) {
	const statusInfo = GIT_STATUS_INFO[file.status] ?? GIT_STATUS_INFO["?"];
	const { fileName, directory } = splitPath(file.path);

	const Icon = staged ? Minus : Plus;
	const actionLabel = staged ? "Unstage file" : "Stage file";

	return (
		<SidebarListItem
			title={fileName}
			subtitle={directory}
			isActive={isActive}
			onSelect={onSelect}
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
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onToggleStage();
					}}
					disabled={isToggling}
					className={`flex items-center justify-center min-h-[36px] min-w-[36px] rounded-md transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent ${
						isToggling
							? "opacity-50 cursor-not-allowed text-th-text-muted"
							: "text-th-text-secondary hover:text-th-text-primary active:scale-95"
					}`}
					aria-label={actionLabel}
				>
					{isToggling ? (
						<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
					) : (
						<Icon className="h-4 w-4" aria-hidden="true" />
					)}
				</button>
			}
		/>
	);
}

export default DiffFileItem;
