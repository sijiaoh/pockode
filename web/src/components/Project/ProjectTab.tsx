import { ListChecks, UserCog } from "lucide-react";
import { deriveActivity, needsUser } from "../../lib/activity";
import { useWorkStore } from "../../lib/workStore";
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
	// One dot, one meaning: someone below this is waiting on the user
	// (docs/lifecycle-ui.md §4). The turn is not passed — a work in a worktree
	// this client has not loaded has none, and a dot that appeared only for the
	// open worktree would be a dot that means two different things.
	const hasNeedsUser = useWorkStore((s) =>
		s.works.some((w) => needsUser(deriveActivity(w, undefined))),
	);

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
