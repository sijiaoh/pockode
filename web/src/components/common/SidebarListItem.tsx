import type { ReactNode } from "react";

interface Props {
	title: string;
	subtitle?: string;
	isActive: boolean;
	hasChanges?: boolean;
	isRunning?: boolean;
	leftSlot?: ReactNode;
	actions?: ReactNode;
	onSelect: () => void;
	ariaLabel?: string;
}

function SidebarListItem({
	title,
	subtitle,
	isActive,
	hasChanges,
	isRunning,
	leftSlot,
	actions,
	onSelect,
	ariaLabel,
}: Props) {
	return (
		<div
			className={`group flex w-full min-h-[44px] items-center gap-2 rounded-lg transition-colors ${
				isActive
					? "bg-th-bg-tertiary border-l-2 border-th-accent"
					: "hover:bg-th-bg-tertiary"
			}`}
		>
			<button
				type="button"
				onClick={onSelect}
				className={`flex min-w-0 flex-1 items-center gap-2 py-2 pl-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset ${actions ? "rounded-l-lg" : "pr-3 rounded-lg"}`}
				aria-label={ariaLabel}
			>
				{leftSlot}
				<div className="min-w-0 flex-1">
					<div
						className={`truncate text-sm text-th-text-primary ${hasChanges ? "" : ""}`}
					>
						{title}
					</div>
					{subtitle && (
						<div className="truncate text-xs text-th-text-muted">
							{subtitle}
						</div>
					)}
				</div>
				{isRunning ? (
					<span
						className="h-3 w-3 shrink-0 rounded-full border-2 border-th-accent border-t-transparent animate-spin"
						aria-label="AI responding"
					/>
				) : (
					hasChanges && (
						<span
							className="h-2 w-2 shrink-0 rounded-full bg-th-accent"
							aria-hidden="true"
						/>
					)
				)}
			</button>
			{actions && <div className="flex items-center gap-1 pr-2">{actions}</div>}
		</div>
	);
}

export default SidebarListItem;
