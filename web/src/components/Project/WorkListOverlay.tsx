import { AlertCircle, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useRoleNameMap } from "../../hooks/useRoleNameMap";
import { ACTIVITY_VIEW, type Activity, needsUser } from "../../lib/activity";
import { useWorkStore } from "../../lib/workStore";
import type { WorkListItem } from "../../types/work";
import { ActivityDot, ActivityIcon } from "../ui";
import BackToChatButton from "../ui/BackToChatButton";
import { WorktreeBadge } from "../Worktree";
import CreateWorkForm from "./CreateWorkForm";
import WorkPrimaryAction, { countActiveChildren } from "./WorkPrimaryAction";

interface Props {
	onBack: () => void;
	onOpenWorkDetail: (workId: string) => void;
	onNavigateToSession: (sessionId: string, worktree: string) => void;
}

export default function WorkListOverlay({
	onBack,
	onOpenWorkDetail,
	onNavigateToSession,
}: Props) {
	const works = useWorkStore((s) => s.works);
	const isLoading = useWorkStore((s) => s.isLoading);
	const error = useWorkStore((s) => s.error);
	const roleNameMap = useRoleNameMap();

	const tasksByParentId = useMemo(() => {
		const map = new Map<string, WorkListItem[]>();
		for (const w of works) {
			if (w.type === "task" && w.parent_id) {
				const list = map.get(w.parent_id);
				if (list) {
					list.push(w);
				} else {
					map.set(w.parent_id, [w]);
				}
			}
		}
		return map;
	}, [works]);

	const storyGroups = useMemo(() => {
		const byGroup = new Map<WorkGroup, WorkListItem[]>();
		for (const w of works) {
			if (w.type !== "story") continue;
			const group = workGroup(w);
			const list = byGroup.get(group);
			if (list) {
				list.push(w);
			} else {
				byGroup.set(group, [w]);
			}
		}
		return GROUP_ORDER.filter((g) => byGroup.has(g)).map((group) => ({
			group,
			stories:
				group === "closed"
					? [...(byGroup.get(group) as WorkListItem[])].sort((a, b) =>
							b.updated_at.localeCompare(a.updated_at),
						)
					: (byGroup.get(group) as WorkListItem[]),
		}));
	}, [works]);

	const hasStories = storyGroups.length > 0;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex items-center gap-1.5 border-b border-th-border bg-th-bg-secondary px-2 py-2">
				<BackToChatButton onClick={onBack} />
				<h1 className="flex-1 px-2 text-sm font-bold text-th-text-primary">
					Project
				</h1>
			</header>

			<div className="min-h-0 flex-1 overflow-auto p-2">
				<div className="mb-2">
					<CreateWorkForm type="story" />
				</div>

				{isLoading ? (
					<div className="flex items-center justify-center py-8">
						<Loader2 className="size-5 animate-spin text-th-text-muted" />
					</div>
				) : error ? (
					<div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-th-error">
						<AlertCircle className="size-5" />
						<p>{error}</p>
					</div>
				) : !hasStories ? (
					<div className="py-8 text-center text-sm text-th-text-muted">
						No items yet
					</div>
				) : (
					<div className="space-y-2">
						{storyGroups.map(({ group, stories }) => (
							<WorkGroupSection
								key={group}
								group={group}
								stories={stories}
								tasksByParentId={tasksByParentId}
								roleNameMap={roleNameMap}
								onOpenWorkDetail={onOpenWorkDetail}
								onNavigateToSession={onNavigateToSession}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * The five groups of the work list (docs/lifecycle-ui.md §6.1).
 *
 * Membership is `status` plus the single `needsUser` predicate, never the full
 * activity: a list that regrouped on every phase change would reorder itself
 * while being read. A work moving between *Needs you* and *Active* is the one
 * movement worth that disruption, since it is the one the user is waiting for.
 */
type WorkGroup = "needs_you" | "active" | "stopped" | "open" | "closed";

/**
 * "Needs you" first, where the status order used to put the running work: a
 * list of work is a list of things to do, and the things needing a person come
 * before the things running by themselves. `stopped` above `open` because a
 * stopped work is something the user already started.
 */
const GROUP_ORDER: WorkGroup[] = [
	"needs_you",
	"active",
	"stopped",
	"open",
	"closed",
];

const GROUP_LABEL: Record<WorkGroup, string> = {
	needs_you: "Needs you",
	active: "Active",
	stopped: "Stopped",
	open: "Open",
	closed: "Closed",
};

/**
 * The leaf each header borrows its glyph and tone from.
 *
 * A header glyph is fixed per group and never taken from the rows inside it:
 * *Needs you* holds three different leaves, and a header wearing one of them
 * would mislabel the other two. The rows keep their own precise leaf, which is
 * where the distinction belongs — so these glyphs are drawn `decorative`, with
 * the group's written label as the only thing announced.
 */
const GROUP_GLYPH: Record<WorkGroup, Activity> = {
	needs_you: "needs_message",
	active: "running",
	stopped: "stopped",
	open: "open",
	closed: "closed",
};

function workGroup(work: WorkListItem): WorkGroup {
	if (work.status !== "active") return work.status;
	return needsUser(work.activity) ? "needs_you" : "active";
}

interface WorkGroupSectionProps {
	group: WorkGroup;
	stories: WorkListItem[];
	tasksByParentId: Map<string, WorkListItem[]>;
	roleNameMap: Map<string, string>;
	onOpenWorkDetail: (workId: string) => void;
	onNavigateToSession: (sessionId: string, worktree: string) => void;
}

function WorkGroupSection({
	group,
	stories,
	tasksByParentId,
	roleNameMap,
	onOpenWorkDetail,
	onNavigateToSession,
}: WorkGroupSectionProps) {
	const [collapsed, setCollapsed] = useState(group === "closed");

	return (
		<div>
			<button
				type="button"
				onClick={() => setCollapsed(!collapsed)}
				aria-expanded={!collapsed}
				className="flex min-h-[44px] w-full items-center gap-2 px-3 text-xs font-medium text-th-text-muted"
			>
				{collapsed ? (
					<ChevronRight className="size-3.5 shrink-0" />
				) : (
					<ChevronDown className="size-3.5 shrink-0" />
				)}
				<ActivityIcon activity={GROUP_GLYPH[group]} decorative />
				<span className="flex-1 text-left">{GROUP_LABEL[group]}</span>
				<span className="rounded-full bg-th-bg-tertiary px-1.5 py-0.5 text-xs tabular-nums text-th-text-muted">
					{stories.length}
				</span>
			</button>
			{!collapsed && (
				<div className="space-y-0.5">
					{stories.map((story) => (
						<StoryRow
							key={story.id}
							story={story}
							tasks={tasksByParentId.get(story.id)}
							roleNameMap={roleNameMap}
							onOpenWorkDetail={onOpenWorkDetail}
							onNavigateToSession={onNavigateToSession}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function StoryRow({
	story,
	tasks,
	roleNameMap,
	onOpenWorkDetail,
	onNavigateToSession,
}: {
	story: WorkListItem;
	tasks: WorkListItem[] | undefined;
	roleNameMap: Map<string, string>;
	onOpenWorkDetail: (workId: string) => void;
	onNavigateToSession: (sessionId: string, worktree: string) => void;
}) {
	const storySessionId = story.session_id;
	const totalTasks = tasks?.length ?? 0;
	const closedTasks = tasks?.filter((t) => t.status === "closed").length ?? 0;
	const roleName = story.agent_role_id
		? (roleNameMap.get(story.agent_role_id) ?? null)
		: null;
	const hasTasks = totalTasks > 0;
	const isTaskListCollapsible = story.status === "closed";
	const [tasksExpanded, setTasksExpanded] = useState(
		() => !isTaskListCollapsible,
	);
	const isTaskListExpanded = isTaskListCollapsible ? tasksExpanded : true;

	return (
		<div className="rounded-lg">
			{/* Title row */}
			<div className="flex min-h-[44px] items-center px-1">
				{hasTasks ? (
					isTaskListCollapsible ? (
						<button
							type="button"
							onClick={() => setTasksExpanded(!tasksExpanded)}
							className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-th-text-muted"
							aria-expanded={isTaskListExpanded}
							aria-label={
								isTaskListExpanded ? "Collapse tasks" : "Expand tasks"
							}
						>
							{isTaskListExpanded ? (
								<ChevronDown className="size-3.5" />
							) : (
								<ChevronRight className="size-3.5" />
							)}
						</button>
					) : (
						<div
							className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-th-text-muted"
							aria-hidden="true"
						>
							<ChevronDown className="size-3.5" />
						</div>
					)
				) : (
					<div className="min-h-[44px] min-w-[44px] shrink-0" />
				)}
				{/* Decorative: the title button below names the leaf in the same
				    breath, and a glyph repeating it announces the row twice. */}
				<ActivityIcon activity={story.activity} decorative />
				<button
					type="button"
					onClick={() => onOpenWorkDetail(story.id)}
					className="ml-2 min-w-0 flex-1 truncate text-left text-sm text-th-text-primary hover:text-th-accent"
					aria-label={`${story.title} — ${ACTIVITY_VIEW[story.activity].label}`}
				>
					{story.title}
				</button>
				{/* The rollup: the story itself, or any of its tasks
				    (docs/lifecycle-ui.md §4). The rows keep their own precise leaf. */}
				{(needsUser(story.activity) ||
					tasks?.some((t) => needsUser(t.activity))) && (
					<ActivityDot className="mr-2" />
				)}
			</div>

			{/* Meta info row — always visible */}
			<div className="flex items-center gap-2 px-3 pb-1 pl-[4.375rem] text-xs text-th-text-muted">
				<WorktreeBadge work={story} className="max-w-[8rem] shrink" />
				<span className="min-w-0 shrink truncate">{roleName ?? "—"}</span>
				{totalTasks > 0 && (
					<>
						<span aria-hidden="true">&middot;</span>
						<span>
							{closedTasks}/{totalTasks} tasks
						</span>
					</>
				)}
				{storySessionId && (
					<>
						<span aria-hidden="true">&middot;</span>
						<button
							type="button"
							onClick={() =>
								onNavigateToSession(storySessionId, story.worktree ?? "")
							}
							className="-my-2 py-2 text-th-accent"
						>
							Chat
						</button>
					</>
				)}
				<WorkPrimaryAction
					work={story}
					activeChildCount={countActiveChildren(tasks ?? [])}
				/>
			</div>

			{/* Task list — collapsible */}
			{isTaskListExpanded && hasTasks && (
				<div className="pb-1 pl-[3rem] pr-2">
					{tasks?.map((task) => (
						<TaskRow
							key={task.id}
							task={task}
							roleNameMap={roleNameMap}
							onOpenWorkDetail={onOpenWorkDetail}
							onNavigateToSession={onNavigateToSession}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function TaskRow({
	task,
	roleNameMap,
	onOpenWorkDetail,
	onNavigateToSession,
}: {
	task: WorkListItem;
	roleNameMap: Map<string, string>;
	onOpenWorkDetail: (workId: string) => void;
	onNavigateToSession: (sessionId: string, worktree: string) => void;
}) {
	const taskSessionId = task.session_id;
	const roleName = task.agent_role_id
		? (roleNameMap.get(task.agent_role_id) ?? null)
		: null;

	// The bar keys off the leaves, not off one of the fields behind them: warning
	// for any of the three ways a task can be waiting on the user, error for a
	// task the engine has let go of (docs/lifecycle-ui.md §6.1).
	const isNeedsUser = needsUser(task.activity);
	const isStopped = task.status === "stopped";

	return (
		<div
			className={`flex min-h-[36px] items-center gap-2 rounded-lg px-2 hover:bg-th-bg-tertiary ${isNeedsUser ? "border-l-2 border-th-warning bg-th-warning/5" : isStopped ? "border-l-2 border-th-error bg-th-error/5" : ""}`}
		>
			<ActivityIcon activity={task.activity} size="sm" />
			<button
				type="button"
				onClick={() => onOpenWorkDetail(task.id)}
				className="min-w-0 flex-1 truncate text-left text-xs text-th-text-primary hover:text-th-accent"
			>
				{task.title}
			</button>
			<span className="shrink-0 text-xs text-th-text-muted">
				{roleName ?? "—"}
			</span>
			{taskSessionId && (
				<button
					type="button"
					onClick={() =>
						onNavigateToSession(taskSessionId, task.worktree ?? "")
					}
					className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-xs text-th-accent"
				>
					Chat
				</button>
			)}
			<WorkPrimaryAction work={task} iconOnly />
		</div>
	);
}
