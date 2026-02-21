import {
	AlertCircle,
	ChevronDown,
	ChevronRight,
	Circle,
	CircleCheck,
	CircleDot,
	Loader2,
	Play,
	Plus,
	Trash2,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useWorkSubscription } from "../../hooks/useWorkSubscription";
import { useWorkStore } from "../../lib/workStore";
import { useWSStore } from "../../lib/wsStore";
import type { Work, WorkStatus, WorkType } from "../../types/work";
import ConfirmDialog from "../common/ConfirmDialog";
import BackToChatButton from "../ui/BackToChatButton";

interface Props {
	onBack: () => void;
	onNavigateToSession: (sessionId: string) => void;
}

export default function WorkListOverlay({
	onBack,
	onNavigateToSession,
}: Props) {
	useWorkSubscription(true);

	const works = useWorkStore((s) => s.works);
	const isLoading = useWorkStore((s) => s.isLoading);
	const error = useWorkStore((s) => s.error);

	const stories = useMemo(
		() => works.filter((w) => w.type === "story"),
		[works],
	);

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

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex items-center gap-1.5 border-b border-th-border bg-th-bg-secondary px-2 py-2">
				<BackToChatButton onClick={onBack} />
				<h1 className="flex-1 px-2 text-sm font-bold text-th-text-primary">
					Work
				</h1>
			</header>

			<div className="min-h-0 flex-1 overflow-auto p-3">
				{isLoading ? (
					<div className="flex items-center justify-center py-8">
						<Loader2 className="size-5 animate-spin text-th-text-muted" />
					</div>
				) : error ? (
					<div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-th-error">
						<AlertCircle className="size-5" />
						<p>{error}</p>
					</div>
				) : stories.length === 0 ? (
					<div className="py-8 text-center text-sm text-th-text-muted">
						No work items yet
					</div>
				) : (
					<div className="space-y-1">
						{stories.map((story) => (
							<StoryItem
								key={story.id}
								story={story}
								tasks={tasksByParentId.get(story.id) ?? emptyTasks}
								onNavigateToSession={onNavigateToSession}
							/>
						))}
					</div>
				)}
			</div>

			<div className="border-t border-th-border p-3">
				<CreateWorkButton type="story" />
			</div>
		</div>
	);
}

const emptyTasks: Work[] = [];

interface StoryItemProps {
	story: Work;
	tasks: Work[];
	onNavigateToSession: (sessionId: string) => void;
}

function StoryItem({ story, tasks, onNavigateToSession }: StoryItemProps) {
	const [expanded, setExpanded] = useState(story.status !== "closed");

	return (
		<div>
			<WorkRow
				work={story}
				onToggle={() => setExpanded(!expanded)}
				expanded={expanded}
				hasChildren={tasks.length > 0}
				onNavigateToSession={onNavigateToSession}
			/>
			{expanded && (
				<div className="ml-5 space-y-0.5 border-l border-th-border pl-2">
					{tasks.map((task) => (
						<WorkRow
							key={task.id}
							work={task}
							onNavigateToSession={onNavigateToSession}
						/>
					))}
					<div className="pt-1">
						<CreateWorkButton type="task" parentId={story.id} />
					</div>
				</div>
			)}
		</div>
	);
}

interface WorkRowProps {
	work: Work;
	onToggle?: () => void;
	expanded?: boolean;
	hasChildren?: boolean;
	onNavigateToSession: (sessionId: string) => void;
}

function WorkRow({
	work,
	onToggle,
	expanded,
	hasChildren,
	onNavigateToSession,
}: WorkRowProps) {
	const startWork = useWSStore((s) => s.actions.startWork);
	const deleteWork = useWSStore((s) => s.actions.deleteWork);
	const [showDelete, setShowDelete] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [isStarting, setIsStarting] = useState(false);

	const handleStart = useCallback(async () => {
		setError(null);
		setIsStarting(true);
		try {
			await startWork(work.id);
		} catch (err) {
			setError(
				`Failed to start: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			setIsStarting(false);
		}
	}, [startWork, work.id]);

	const handleDelete = useCallback(async () => {
		try {
			await deleteWork(work.id);
			setShowDelete(false);
		} catch (err) {
			setError(
				`Failed to delete: ${err instanceof Error ? err.message : String(err)}`,
			);
			setShowDelete(false);
		}
	}, [deleteWork, work.id]);

	const canDelete =
		work.status === "open" || (work.status !== "closed" && !hasChildren);

	return (
		<>
			<div className="group flex min-h-[36px] items-center gap-1.5 rounded px-1.5 hover:bg-th-bg-tertiary">
				{work.type === "story" && (
					<button
						type="button"
						onClick={onToggle}
						className="flex size-5 items-center justify-center text-th-text-muted"
					>
						{expanded ? (
							<ChevronDown className="size-3.5" />
						) : (
							<ChevronRight className="size-3.5" />
						)}
					</button>
				)}

				<StatusIcon status={work.status} />

				<span className="min-w-0 flex-1 truncate text-sm text-th-text-primary">
					{work.title}
				</span>

				{work.session_id && (
					<button
						type="button"
						onClick={() => onNavigateToSession(work.session_id ?? "")}
						className="shrink-0 rounded px-1.5 py-0.5 text-xs text-th-accent hover:bg-th-bg-tertiary"
					>
						Chat
					</button>
				)}

				{work.status === "open" && (
					<button
						type="button"
						onClick={handleStart}
						disabled={isStarting}
						className="shrink-0 rounded p-1 text-th-text-muted transition-opacity hover:text-th-accent md:opacity-0 md:group-hover:opacity-100"
						aria-label="Start"
					>
						{isStarting ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : (
							<Play className="size-3.5" />
						)}
					</button>
				)}

				{canDelete && (
					<button
						type="button"
						onClick={() => setShowDelete(true)}
						className="shrink-0 rounded p-1 text-th-text-muted transition-opacity hover:text-th-error md:opacity-0 md:group-hover:opacity-100"
						aria-label="Delete"
					>
						<Trash2 className="size-3.5" />
					</button>
				)}
			</div>

			{error && (
				<p className="px-1.5 py-1 text-xs text-th-error" role="alert">
					{error}
				</p>
			)}

			{showDelete && (
				<ConfirmDialog
					title="Delete work"
					message={`Delete "${work.title}"?`}
					confirmLabel="Delete"
					variant="danger"
					onConfirm={handleDelete}
					onCancel={() => setShowDelete(false)}
				/>
			)}
		</>
	);
}

interface StatusIconProps {
	status: WorkStatus;
}

function StatusIcon({ status }: StatusIconProps) {
	switch (status) {
		case "open":
			return <Circle className="size-3.5 shrink-0 text-th-text-muted" />;
		case "in_progress":
			return <CircleDot className="size-3.5 shrink-0 text-th-accent" />;
		case "done":
			return <CircleCheck className="size-3.5 shrink-0 text-th-warning" />;
		case "closed":
			return <CircleCheck className="size-3.5 shrink-0 text-th-success" />;
	}
}

interface CreateWorkButtonProps {
	type: WorkType;
	parentId?: string;
}

function CreateWorkButton({ type, parentId }: CreateWorkButtonProps) {
	const [isCreating, setIsCreating] = useState(false);
	const [title, setTitle] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const createWork = useWSStore((s) => s.actions.createWork);

	const handleSubmit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			const trimmed = title.trim();
			if (!trimmed || isSubmitting) return;

			setError(null);
			setIsSubmitting(true);
			try {
				await createWork({
					type,
					parent_id: parentId,
					title: trimmed,
				});
				setTitle("");
				setIsCreating(false);
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to create work");
			} finally {
				setIsSubmitting(false);
			}
		},
		[title, type, parentId, createWork, isSubmitting],
	);

	if (!isCreating) {
		return (
			<button
				type="button"
				onClick={() => setIsCreating(true)}
				className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-primary"
			>
				<Plus className="size-3" />
				{type === "story" ? "Add Story" : "Add Task"}
			</button>
		);
	}

	return (
		<div>
			<form onSubmit={handleSubmit} className="flex gap-1.5 px-1">
				<input
					type="text"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					placeholder={type === "story" ? "Story title" : "Task title"}
					className="min-w-0 flex-1 rounded border border-th-border bg-th-bg-primary px-2 py-1.5 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none"
					// biome-ignore lint/a11y/noAutofocus: inline creation form
					autoFocus
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							setIsCreating(false);
							setTitle("");
							setError(null);
						}
					}}
				/>
				<button
					type="submit"
					disabled={!title.trim() || isSubmitting}
					className="rounded bg-th-accent px-3 py-1.5 text-xs text-th-accent-text disabled:opacity-50"
				>
					{isSubmitting ? "Adding..." : "Add"}
				</button>
			</form>
			{error && (
				<p className="px-1 pt-1 text-xs text-th-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
