import { ListChecks, UserCog } from "lucide-react";
import { useWorkNeedsAttention } from "../../lib/workStore";
import { useSidebarRefresh } from "../Layout";
import { ActivityDot } from "../ui";

interface Props {
	onOpenWorkList: () => void;
	onOpenAgentRoleList: () => void;
}

export default function ProjectTab({
	onOpenWorkList,
	onOpenAgentRoleList,
}: Props) {
	const { isActive } = useSidebarRefresh("project");
	// The same bit the tab bar badges, so the dot inside and the badge outside
	// can never disagree. Both stay: the badge says which tab to open, the dot
	// says where to look once it is open.
	const hasNeedsUser = useWorkNeedsAttention();

	return (
		<div className={isActive ? "space-y-1 p-2" : "hidden"}>
			<button
				type="button"
				onClick={onOpenWorkList}
				className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-th-text-primary transition-colors hover:bg-th-bg-tertiary active:scale-[0.98]"
			>
				<ListChecks className="size-4 text-th-text-muted" />
				Project
				{hasNeedsUser && <ActivityDot className="ml-auto" />}
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
