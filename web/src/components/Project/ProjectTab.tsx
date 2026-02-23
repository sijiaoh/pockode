import { ListChecks, UserCog } from "lucide-react";
import { useWorkStore } from "../../lib/workStore";
import { useSidebarRefresh } from "../Layout";

interface Props {
	onOpenWorkList: () => void;
	onOpenAgentRoleList: () => void;
}

export default function ProjectTab({
	onOpenWorkList,
	onOpenAgentRoleList,
}: Props) {
	const { isActive } = useSidebarRefresh("project");
	const hasNeedsInput = useWorkStore((s) =>
		s.works.some((w) => w.status === "needs_input"),
	);

	return (
		<div className={isActive ? "space-y-1 p-2" : "hidden"}>
			<button
				type="button"
				onClick={onOpenWorkList}
				className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-th-text-primary transition-colors hover:bg-th-bg-tertiary active:scale-[0.98]"
			>
				<ListChecks className="size-4 text-th-text-muted" />
				Tasks
				{hasNeedsInput && (
					<span
						className="ml-auto h-2 w-2 shrink-0 rounded-full bg-th-warning"
						aria-hidden="true"
					/>
				)}
			</button>
			<button
				type="button"
				onClick={onOpenAgentRoleList}
				className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-th-text-primary transition-colors hover:bg-th-bg-tertiary active:scale-[0.98]"
			>
				<UserCog className="size-4 text-th-text-muted" />
				Agent Roles
			</button>
		</div>
	);
}
