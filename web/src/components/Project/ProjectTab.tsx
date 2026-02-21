import { ListChecks } from "lucide-react";
import { useSidebarRefresh } from "../Layout";

interface Props {
	onOpenWorkList: () => void;
}

export default function ProjectTab({ onOpenWorkList }: Props) {
	const { isActive } = useSidebarRefresh("project");

	return (
		<div className={isActive ? "space-y-1 p-2" : "hidden"}>
			<button
				type="button"
				onClick={onOpenWorkList}
				className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-th-text-primary transition-colors hover:bg-th-bg-tertiary active:scale-[0.98]"
			>
				<ListChecks className="size-4 text-th-text-muted" />
				Work List
			</button>
		</div>
	);
}
