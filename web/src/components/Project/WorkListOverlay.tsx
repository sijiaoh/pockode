import {
	AlertCircle,
	ChevronDown,
	ChevronRight,
	Loader2,
	Play,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useAgentRoleSubscription } from "../../hooks/useAgentRoleSubscription";
import { useWorkSubscription } from "../../hooks/useWorkSubscription";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { useWorkStore } from "../../lib/workStore";
import { useWSStore } from "../../lib/wsStore";
import type { Work, WorkStatus } from "../../types/work";
import BackToChatButton from "../ui/BackToChatButton";
import { statusLabels } from "../ui/StatusBadge";
import StatusIcon from "../ui/StatusIcon";
import CreateWorkForm from "./CreateWorkForm";

interface Props {
	onBack: () => void;
	onOpenWorkDetail: (workId: string) => void;
	onNavigateToSession: (sessionId: string) => void;
}

export default function WorkListOverlay({
	onBack,
	onOpenWorkDetail,
	onNavigateToSession,
}: Props) {
	useWorkSubscription(true);
	useAgentRoleSubscription(true);

	const works = useWorkStore((s) => s.works);
	const isLoading = useWorkStore((s) => s.isLoading);
	const error = useWorkStore((s) => s.error);
	const roles = useAgentRoleStore((s) => s.roles);

	const roleNameMap = useMemo(() => {
		const map = new Map<string, string>();
		for (const r of roles) {
			map.set(r.id, r.name);
		}
		return map;
	}, [roles]);

	const tasksByParentId = useMemo(() => {
		const map = new Map<string, Work[]>();
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
		const byStatus = new Map<WorkStatus, Work[]>();
		for (const w of works) {
			if (w.type !== "story") continue;
			const list = byStatus.get(w.status);
			if (list) {
				list.push(w);
			} else {
				byStatus.set(w.status, [w]);
			}
		}
		return statusGroupOrder
			.filter((s) => byStatus.has(s))
			.map((status) => ({
				status,
				stories: byStatus.get(status) as Work[],
			}));
	}, [works]);

	const hasStories = storyGroups.length > 0;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex items-center gap-1.5 border-b border-th-border bg-th-bg-secondary px-2 py-2">
				<BackToChatButton onClick={onBack} />
				<h1 className="flex-1 px-2 text-sm font-bold text-th-text-primary">
					Stories
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
						No stories yet
					</div>
				) : (
					<div className="space-y-2">
						{storyGroups.map(({ status, stories }) => (
							<StatusGroup
								key={status}
								status={status}
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

const statusGroupOrder: WorkStatus[] = [
	"in_progress",
	"needs_input",
	"open",
	"done",
	"closed",
];

interface StatusGroupProps {
	status: WorkStatus;
	stories: Work[];
	tasksByParentId: Map<string, Work[]>;
	roleNameMap: Map<string, string>;
	onOpenWorkDetail: (workId: string) => void;
	onNavigateToSession: (sessionId: string) => void;
}

function StatusGroup({
	status,
	stories,
	tasksByParentId,
	roleNameMap,
	onOpenWorkDetail,
	onNavigateToSession,
}: StatusGroupProps) {
	const [collapsed, setCollapsed] = useState(status === "closed");

	return (
		<div>
			<button
				type="button"
				onClick={() => setCollapsed(!collapsed)}
				className="flex min-h-[44px] w-full items-center gap-2 px-3 text-xs font-medium text-th-text-muted"
			>
				{collapsed ? (
					<ChevronRight className="size-3.5 shrink-0" />
				) : (
					<ChevronDown className="size-3.5 shrink-0" />
				)}
				<StatusIcon status={status} />
				<span className="flex-1 text-left">{statusLabels[status]}</span>
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
	story: Work;
	tasks: Work[] | undefined;
	roleNameMap: Map<string, string>;
	onOpenWorkDetail: (workId: string) => void;
	onNavigateToSession: (sessionId: string) => void;
}) {
	const totalTasks = tasks?.length ?? 0;
	const doneTasks =
		tasks?.filter((t) => t.status === "done" || t.status === "closed").length ??
		0;
	const roleName = story.agent_role_id
		? (roleNameMap.get(story.agent_role_id) ?? null)
		: null;

	return (
		<div className="rounded-lg">
			{/* Title row */}
			<div className="flex min-h-[44px] items-center gap-2 px-3">
				<StatusIcon status={story.status} />
				<button
					type="button"
					onClick={() => onOpenWorkDetail(story.id)}
					className="min-w-0 flex-1 truncate text-left text-sm text-th-text-primary hover:text-th-accent"
					aria-label={`${story.title} — ${statusLabels[story.status]}`}
				>
					{story.title}
				</button>
				{story.status === "in_progress" && (
					<output
						className="h-3 w-3 shrink-0 rounded-full border-2 border-th-accent border-t-transparent animate-spin"
						aria-label="AI responding"
					/>
				)}
				{story.status === "needs_input" && (
					<span
						className="h-2 w-2 shrink-0 rounded-full bg-th-warning"
						aria-hidden="true"
					/>
				)}
			</div>

			{/* Meta info row */}
			<div className="flex items-center gap-2 px-3 pb-1 pl-[2.125rem] text-xs text-th-text-muted">
				<span>{roleName ?? "—"}</span>
				{totalTasks > 0 && (
					<>
						<span aria-hidden="true">&middot;</span>
						<span>
							{doneTasks}/{totalTasks} tasks
						</span>
					</>
				)}
				{story.session_id && (
					<>
						<span aria-hidden="true">&middot;</span>
						<button
							type="button"
							onClick={() => onNavigateToSession(story.session_id ?? "")}
							className="-my-2 py-2 text-th-accent"
						>
							Chat
						</button>
					</>
				)}
				{story.status === "open" && <StartButton workId={story.id} />}
			</div>

			{/* Task list */}
			{tasks && tasks.length > 0 && (
				<div className="pb-1 pl-6 pr-2">
					{tasks.map((task) => (
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
	task: Work;
	roleNameMap: Map<string, string>;
	onOpenWorkDetail: (workId: string) => void;
	onNavigateToSession: (sessionId: string) => void;
}) {
	const roleName = task.agent_role_id
		? (roleNameMap.get(task.agent_role_id) ?? null)
		: null;

	return (
		<div className="flex min-h-[36px] items-center gap-2 rounded-lg px-2 hover:bg-th-bg-tertiary">
			<StatusIcon status={task.status} size="sm" />
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
			{task.session_id && (
				<button
					type="button"
					onClick={() => onNavigateToSession(task.session_id ?? "")}
					className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-xs text-th-accent"
				>
					Chat
				</button>
			)}
			{task.status === "open" && !task.session_id && (
				<StartButton workId={task.id} iconOnly />
			)}
		</div>
	);
}

function StartButton({
	workId,
	iconOnly,
}: {
	workId: string;
	iconOnly?: boolean;
}) {
	const startWork = useWSStore((s) => s.actions.startWork);
	const [isStarting, setIsStarting] = useState(false);
	const startingRef = useRef(false);
	const [error, setError] = useState<string | null>(null);

	const handleStart = useCallback(
		async (e: React.MouseEvent) => {
			e.stopPropagation();
			if (startingRef.current) return;
			startingRef.current = true;
			setError(null);
			setIsStarting(true);
			try {
				await startWork(workId);
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to start");
			} finally {
				startingRef.current = false;
				setIsStarting(false);
			}
		},
		[startWork, workId],
	);

	if (iconOnly) {
		return (
			<button
				type="button"
				onClick={handleStart}
				disabled={isStarting}
				className={`flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center disabled:opacity-50 ${error ? "text-th-error" : "text-th-accent"}`}
				aria-label={error ?? "Start"}
			>
				{isStarting ? (
					<Loader2 className="size-3.5 animate-spin" />
				) : (
					<Play className="size-3.5" />
				)}
			</button>
		);
	}

	return (
		<button
			type="button"
			onClick={handleStart}
			disabled={isStarting}
			className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs disabled:opacity-50 ${error ? "bg-th-error/10 text-th-error" : "bg-th-accent/10 text-th-accent"}`}
			aria-label={error ?? undefined}
		>
			{isStarting ? (
				<Loader2 className="size-3 animate-spin" />
			) : (
				<Play className="size-3" />
			)}
			{error ? "Error" : "Start"}
		</button>
	);
}
