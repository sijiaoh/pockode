import { CalendarClock, ListChecks, UserCog } from "lucide-react";
import { useScheduleNeedsAttention } from "../../lib/scheduleStore";
import { useWorkNeedsAttention } from "../../lib/workStore";
import { useSidebarRefresh } from "../Layout";
import { ActivityDot } from "../ui";

interface Props {
	onOpenWorkList: () => void;
	onOpenScheduleList: () => void;
	onOpenAgentRoleList: () => void;
}

/**
 * The tab is the place and the entries are what is in it, so the tab keeps the
 * name Project while its first entry is named for the list it opens.
 * Schedules sits between the two: used less than Stories, more than Agent
 * Roles (docs/schedule-ui.md §1).
 */
export default function ProjectTab({
	onOpenWorkList,
	onOpenScheduleList,
	onOpenAgentRoleList,
}: Props) {
	const { isActive } = useSidebarRefresh("project");
	// The two halves of the bit the tab bar badges (`useProjectNeedsAttention`),
	// one per entry, so the dots inside and the badge outside can never
	// disagree. Both stay: the badge says which tab to open, a dot says which
	// entry to look in once it is open.
	const storiesNeedUser = useWorkNeedsAttention();
	const schedulesNeedUser = useScheduleNeedsAttention();

	return (
		<div className={isActive ? "space-y-1 p-2" : "hidden"}>
			<button
				type="button"
				onClick={onOpenWorkList}
				className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-th-text-primary transition-colors hover:bg-th-bg-tertiary active:scale-[0.98]"
			>
				<ListChecks className="size-4 text-th-text-muted" />
				Stories
				{storiesNeedUser && <ActivityDot className="ml-auto" />}
			</button>
			<button
				type="button"
				onClick={onOpenScheduleList}
				className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-th-text-primary transition-colors hover:bg-th-bg-tertiary active:scale-[0.98]"
			>
				<CalendarClock className="size-4 text-th-text-muted" />
				Schedules
				{schedulesNeedUser && <ActivityDot className="ml-auto" />}
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
