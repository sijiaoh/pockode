import { ChevronRight, MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import { splitPath } from "../../utils/path";
import Spinner from "./Spinner";

interface Props {
	path: string;
	pathColor?: string;
	isLoading?: boolean;
	error?: Error | null;
	onBack: () => void;
	onPathClick?: () => void;
	headerActions?: ReactNode;
	children: ReactNode;
}

function PathDisplay({
	path,
	pathColor = "text-th-text-primary",
	onClick,
}: {
	path: string;
	pathColor?: string;
	onClick?: () => void;
}) {
	const { fileName, directory } = splitPath(path);
	const content = (
		<>
			<div className={`truncate text-sm font-medium ${pathColor}`}>
				{fileName}
			</div>
			{directory && (
				<div className="truncate text-xs text-th-text-muted">{directory}</div>
			)}
		</>
	);

	if (onClick) {
		return (
			<button
				type="button"
				onClick={onClick}
				className="min-w-0 max-w-full flex items-center gap-1 text-left rounded-md border border-th-border bg-th-bg-secondary px-2 py-1 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent text-th-text-secondary hover:bg-th-bg-primary hover:text-th-text-primary active:scale-[0.97]"
				aria-label={`Open ${fileName}`}
			>
				<div className="min-w-0 flex-1">{content}</div>
				<ChevronRight className="h-4 w-4 shrink-0" />
			</button>
		);
	}

	return <div className="min-w-0 max-w-full px-2">{content}</div>;
}

const navButtonClass =
	"flex items-center justify-center rounded-md border border-th-border bg-th-bg-tertiary min-h-[44px] min-w-[44px] p-2 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent text-th-text-secondary hover:border-th-border-focus hover:bg-th-bg-primary hover:text-th-text-primary active:scale-[0.97]";

export default function ContentView({
	path,
	pathColor,
	isLoading,
	error,
	onBack,
	onPathClick,
	headerActions,
	children,
}: Props) {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center gap-1.5 border-b border-th-border bg-th-bg-secondary px-2 py-2">
				<button
					type="button"
					onClick={onBack}
					className={navButtonClass}
					aria-label="Back to chat"
				>
					<MessageSquare className="h-5 w-5" aria-hidden="true" />
				</button>

				{headerActions}

				<PathDisplay path={path} pathColor={pathColor} onClick={onPathClick} />
			</div>

			<div className="min-h-0 flex-1 overflow-auto">
				{isLoading ? (
					<div className="flex items-center justify-center p-8">
						<Spinner className="text-th-text-muted" />
					</div>
				) : error ? (
					<div className="p-4 text-center text-th-error">
						<div className="font-medium">Failed to load</div>
						<div className="mt-1 text-sm text-th-text-muted">
							{error.message}
						</div>
					</div>
				) : (
					children
				)}
			</div>
		</div>
	);
}
