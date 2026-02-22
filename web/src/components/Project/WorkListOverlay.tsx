import {
	AlertCircle,
	ChevronDown,
	ChevronRight,
	Loader2,
	Plus,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgentRoleSubscription } from "../../hooks/useAgentRoleSubscription";
import { useWorkSubscription } from "../../hooks/useWorkSubscription";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { useWorkStore } from "../../lib/workStore";
import { useWSStore } from "../../lib/wsStore";
import type { Work, WorkStatus, WorkType } from "../../types/work";
import SidebarListItem from "../common/SidebarListItem";
import BackToChatButton from "../ui/BackToChatButton";
import { statusLabels } from "../ui/StatusBadge";
import StatusIcon from "../ui/StatusIcon";

interface Props {
	onBack: () => void;
	onOpenWorkDetail: (workId: string) => void;
}

export default function WorkListOverlay({ onBack, onOpenWorkDetail }: Props) {
	useWorkSubscription(true);
	useAgentRoleSubscription(true);

	const works = useWorkStore((s) => s.works);
	const isLoading = useWorkStore((s) => s.isLoading);
	const error = useWorkStore((s) => s.error);

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
					<CreateWorkButton type="story" />
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
								onOpenWorkDetail={onOpenWorkDetail}
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
	onOpenWorkDetail: (workId: string) => void;
}

function StatusGroup({
	status,
	stories,
	tasksByParentId,
	onOpenWorkDetail,
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
					{stories.map((story) => {
						const tasks = tasksByParentId.get(story.id);
						const totalTasks = tasks?.length ?? 0;
						const doneTasks =
							tasks?.filter((t) => t.status === "done" || t.status === "closed")
								.length ?? 0;

						const subtitle =
							totalTasks > 0
								? `${doneTasks}/${totalTasks} tasks done`
								: undefined;

						return (
							<SidebarListItem
								key={story.id}
								title={story.title}
								subtitle={subtitle}
								isActive={false}
								isRunning={story.status === "in_progress"}
								needsInput={story.status === "needs_input"}
								leftSlot={<StatusIcon status={story.status} />}
								onSelect={() => onOpenWorkDetail(story.id)}
								ariaLabel={`${story.title} — ${statusLabels[story.status]}`}
							/>
						);
					})}
				</div>
			)}
		</div>
	);
}

function CreateWorkButton({ type }: { type: WorkType }) {
	const [isCreating, setIsCreating] = useState(false);
	const [title, setTitle] = useState("");
	const [agentRoleId, setAgentRoleId] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const createWork = useWSStore((s) => s.actions.createWork);
	const roles = useAgentRoleStore((s) => s.roles);

	// Auto-select when there's only one role
	useEffect(() => {
		if (roles.length === 1 && !agentRoleId) {
			setAgentRoleId(roles[0].id);
		}
	}, [roles, agentRoleId]);

	const handleSubmit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			const trimmed = title.trim();
			if (!trimmed || !agentRoleId || isSubmitting) return;

			setError(null);
			setIsSubmitting(true);
			try {
				await createWork({
					type,
					agent_role_id: agentRoleId,
					title: trimmed,
				});
				setTitle("");
				setAgentRoleId(roles.length === 1 ? roles[0].id : "");
				setIsCreating(false);
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to create story");
			} finally {
				setIsSubmitting(false);
			}
		},
		[title, type, agentRoleId, createWork, isSubmitting, roles],
	);

	if (!isCreating) {
		return (
			<button
				type="button"
				onClick={() => setIsCreating(true)}
				className="flex min-h-[44px] w-full items-center gap-2 rounded-lg px-3 text-sm text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-primary"
			>
				<Plus className="size-4" />
				{type === "story" ? "New Story" : "Add Task"}
			</button>
		);
	}

	if (roles.length === 0) {
		return (
			<div className="rounded-lg bg-th-bg-secondary p-3 text-xs text-th-text-muted">
				<p>No agent roles registered.</p>
				<p className="mt-1">
					Create a role in{" "}
					<span className="font-medium text-th-text-secondary">
						Agent Roles
					</span>{" "}
					first.
				</p>
				<button
					type="button"
					onClick={() => setIsCreating(false)}
					className="mt-2 min-h-[44px] text-sm text-th-text-muted hover:text-th-text-primary"
				>
					Cancel
				</button>
			</div>
		);
	}

	return (
		<div className="rounded-lg bg-th-bg-secondary p-3">
			<form onSubmit={handleSubmit} className="space-y-2">
				<input
					type="text"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					placeholder={type === "story" ? "Story title" : "Task title"}
					className="min-h-[44px] w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none"
					// biome-ignore lint/a11y/noAutofocus: inline creation form
					autoFocus
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							setIsCreating(false);
							setTitle("");
							setAgentRoleId(roles.length === 1 ? roles[0].id : "");
							setError(null);
						}
					}}
				/>
				<select
					value={agentRoleId}
					onChange={(e) => setAgentRoleId(e.target.value)}
					className="min-h-[44px] w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary focus:border-th-accent focus:outline-none"
				>
					<option value="">Select role...</option>
					{roles.map((role) => (
						<option key={role.id} value={role.id}>
							{role.name}
						</option>
					))}
				</select>
				<div className="flex gap-2">
					<button
						type="submit"
						disabled={!title.trim() || !agentRoleId || isSubmitting}
						className="min-h-[44px] flex-1 rounded-lg bg-th-accent px-3 text-sm font-medium text-th-accent-text disabled:opacity-50"
					>
						{isSubmitting ? "Adding..." : "Add"}
					</button>
					<button
						type="button"
						onClick={() => {
							setIsCreating(false);
							setTitle("");
							setAgentRoleId(roles.length === 1 ? roles[0].id : "");
							setError(null);
						}}
						className="min-h-[44px] rounded-lg px-3 text-sm text-th-text-muted hover:bg-th-bg-tertiary"
					>
						Cancel
					</button>
				</div>
			</form>
			{error && (
				<p className="mt-2 text-xs text-th-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
