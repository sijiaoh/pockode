import {
	AlertCircle,
	Check,
	Loader2,
	MessageSquare,
	Pencil,
	Play,
	Square,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useInlineEdit } from "../../hooks/useInlineEdit";
import { useRoleNameMap } from "../../hooks/useRoleNameMap";
import { useWorkDetailSubscription } from "../../hooks/useWorkDetailSubscription";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { useWorkStore } from "../../lib/workStore";
import { useWSStore } from "../../lib/wsStore";
import type { Comment, Work, WorkType } from "../../types/work";
import { autoResizeTextarea } from "../../utils/dom";
import { MarkdownContent } from "../Chat/MarkdownContent";
import ConfirmDialog from "../common/ConfirmDialog";
import BackButton from "../ui/BackButton";
import BottomActionBar from "../ui/BottomActionBar";
import StatusBadge from "../ui/StatusBadge";
import StatusIcon from "../ui/StatusIcon";
import CreateWorkForm from "./CreateWorkForm";
import { StartButton } from "./WorkListOverlay";

interface Props {
	workId: string;
	onBack: () => void;
	onNavigateToSession: (sessionId: string) => void;
	onOpenWorkDetail: (workId: string) => void;
}

export default function WorkDetailOverlay({
	workId,
	onBack,
	onNavigateToSession,
	onOpenWorkDetail,
}: Props) {
	const { work, comments, loading, error } = useWorkDetailSubscription(workId);

	const works = useWorkStore((s) => s.works);
	const roleNameMap = useRoleNameMap();
	const children = useMemo(
		() => works.filter((w) => w.parent_id === workId),
		[works, workId],
	);
	const parent = useMemo(
		() => (work?.parent_id ? works.find((w) => w.id === work.parent_id) : null),
		[works, work],
	);

	if (loading) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<DetailHeader onBack={onBack} />
				<div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-th-text-muted">
					<Loader2 className="size-5 animate-spin" />
					<p>Loading...</p>
				</div>
			</div>
		);
	}

	if (error || !work) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<DetailHeader onBack={onBack} />
				<div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-th-text-muted">
					<AlertCircle className="size-5" />
					<p>{error ?? "Item not found"}</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<DetailHeader
				onBack={parent ? () => onOpenWorkDetail(parent.id) : onBack}
				type={work.type}
				backLabel={parent ? "Back to parent story" : "Back to stories"}
			/>
			<div className="min-h-0 flex-1 overflow-auto">
				<div className="space-y-5 p-4">
					<div>
						{parent && (
							<p className="mb-1 text-xs text-th-text-muted">{parent.title}</p>
						)}
						<InlineEditableTitle work={work} />
						<div className="mt-2">
							<StatusBadge status={work.status} />
						</div>
					</div>

					<RoleSection work={work} />

					<InlineEditableBody work={work} />

					{work.type === "story" && (
						<ChildrenSection
							storyId={work.id}
							tasks={children}
							roleNameMap={roleNameMap}
							onOpenWorkDetail={onOpenWorkDetail}
							onNavigateToSession={onNavigateToSession}
						/>
					)}

					<CommentsSection comments={comments} />

					<DeleteSection
						work={work}
						childCount={children.length}
						onBack={onBack}
					/>
				</div>
			</div>

			<ActionBar work={work} onNavigateToSession={onNavigateToSession} />
		</div>
	);
}

const typeLabels: Record<WorkType, string> = {
	story: "Story",
	task: "Task",
};

function DetailHeader({
	onBack,
	type,
	backLabel = "Back to stories",
}: {
	onBack: () => void;
	type?: WorkType;
	backLabel?: string;
}) {
	return (
		<header className="flex items-center gap-1.5 border-b border-th-border bg-th-bg-secondary px-2 py-2">
			<BackButton onClick={onBack} aria-label={backLabel} />
			<h1 className="flex-1 px-2 text-sm font-bold text-th-text-primary">
				{type ? typeLabels[type] : "Detail"}
			</h1>
		</header>
	);
}

function ActionBar({
	work,
	onNavigateToSession,
}: {
	work: Work;
	onNavigateToSession: (sessionId: string) => void;
}) {
	const startWork = useWSStore((s) => s.actions.startWork);
	const stopWork = useWSStore((s) => s.actions.stopWork);
	const [isStarting, setIsStarting] = useState(false);
	const [isStopping, setIsStopping] = useState(false);
	const [error, setError] = useState<string | null>(null);

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

	const handleStop = useCallback(async () => {
		setError(null);
		setIsStopping(true);
		try {
			await stopWork(work.id);
		} catch (err) {
			setError(
				`Failed to stop: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			setIsStopping(false);
		}
	}, [stopWork, work.id]);

	const showStart = work.status === "open" || work.status === "stopped";
	const showStop =
		work.status === "in_progress" || work.status === "needs_input";
	const showChat = !!work.session_id;

	if (!showStart && !showStop && !showChat) return null;

	return (
		<BottomActionBar>
			{error && (
				<p className="mb-1.5 text-xs text-th-error" role="alert">
					{error}
				</p>
			)}
			<div className="flex gap-2">
				{showStart && (
					<button
						type="button"
						onClick={handleStart}
						disabled={isStarting}
						className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg bg-th-accent text-sm font-medium text-th-accent-text disabled:opacity-50"
					>
						{isStarting ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							<Play className="size-4" />
						)}
						{work.status === "stopped" ? "Restart" : "Start"}
					</button>
				)}
				{showStop && (
					<button
						type="button"
						onClick={handleStop}
						disabled={isStopping}
						className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg bg-th-error/10 text-sm font-medium text-th-error disabled:opacity-50"
					>
						{isStopping ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							<Square className="size-4" />
						)}
						Stop
					</button>
				)}
				{showChat && (
					<button
						type="button"
						onClick={() => onNavigateToSession(work.session_id ?? "")}
						className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg border border-th-border text-sm font-medium text-th-text-primary hover:bg-th-bg-tertiary"
					>
						<MessageSquare className="size-4" />
						Open Chat
					</button>
				)}
			</div>
		</BottomActionBar>
	);
}

function InlineEditableTitle({ work }: { work: Work }) {
	const updateWork = useWSStore((s) => s.actions.updateWork);
	const {
		editing,
		setEditing,
		value,
		setValue,
		saving,
		error,
		ref,
		save,
		cancel,
	} = useInlineEdit<HTMLInputElement>({
		initialValue: work.title,
		onSave: useCallback(
			(trimmed: string) => updateWork({ id: work.id, title: trimmed }),
			[updateWork, work.id],
		),
	});

	if (editing) {
		return (
			<div>
				<div className="flex items-center gap-1">
					<input
						ref={ref}
						type="text"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") save();
							if (e.key === "Escape") cancel();
						}}
						disabled={saving}
						className="min-w-0 flex-1 rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-lg font-bold text-th-text-primary focus:border-th-accent focus:outline-none"
					/>
					<button
						type="button"
						onClick={save}
						disabled={saving || !value.trim()}
						className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-th-success hover:bg-th-bg-tertiary disabled:opacity-50"
						aria-label="Save"
					>
						{saving ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							<Check className="size-4" />
						)}
					</button>
					<button
						type="button"
						onClick={cancel}
						disabled={saving}
						className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-th-text-muted hover:bg-th-bg-tertiary"
						aria-label="Cancel"
					>
						<X className="size-4" />
					</button>
				</div>
				{error && (
					<p className="mt-1 text-xs text-th-error" role="alert">
						{error}
					</p>
				)}
			</div>
		);
	}

	return (
		<div className="group flex items-start gap-1">
			<h2 className="min-w-0 flex-1 text-lg font-bold text-th-text-primary">
				{work.title}
			</h2>
			<button
				type="button"
				onClick={() => setEditing(true)}
				className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg text-th-text-muted opacity-60 transition-opacity hover:bg-th-bg-tertiary hover:text-th-text-primary md:opacity-0 md:group-hover:opacity-100"
				aria-label="Edit title"
			>
				<Pencil className="size-4" />
			</button>
		</div>
	);
}

function RoleSection({ work }: { work: Work }) {
	const updateWork = useWSStore((s) => s.actions.updateWork);
	const roles = useAgentRoleStore((s) => s.roles);
	const [editingRole, setEditingRole] = useState(false);
	const [savingRole, setSavingRole] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const roleName = useMemo(() => {
		if (!work.agent_role_id) return null;
		return roles.find((r) => r.id === work.agent_role_id)?.name ?? null;
	}, [work.agent_role_id, roles]);

	const handleRoleChange = useCallback(
		async (newRoleId: string) => {
			if (!newRoleId || newRoleId === work.agent_role_id) {
				setEditingRole(false);
				return;
			}
			setError(null);
			setSavingRole(true);
			try {
				await updateWork({ id: work.id, agent_role_id: newRoleId });
				setEditingRole(false);
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to update role");
			} finally {
				setSavingRole(false);
			}
		},
		[work.id, work.agent_role_id, updateWork],
	);

	return (
		<div>
			<h3 className="mb-1 text-xs font-medium text-th-text-muted uppercase">
				Role
			</h3>
			{editingRole ? (
				<div className="flex items-center gap-2">
					<select
						value={work.agent_role_id ?? ""}
						onChange={(e) => handleRoleChange(e.target.value)}
						onBlur={() => {
							if (!savingRole) setEditingRole(false);
						}}
						disabled={savingRole}
						className="min-h-[44px] flex-1 rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary focus:border-th-accent focus:outline-none"
						// biome-ignore lint/a11y/noAutofocus: inline edit
						autoFocus
					>
						{!work.agent_role_id && <option value="">Select role...</option>}
						{roles.map((role) => (
							<option key={role.id} value={role.id}>
								{role.name}
							</option>
						))}
					</select>
					{savingRole && (
						<Loader2 className="size-4 animate-spin text-th-text-muted" />
					)}
				</div>
			) : (
				<button
					type="button"
					onClick={() => setEditingRole(true)}
					className="group flex min-h-[44px] items-center gap-1.5 text-sm text-th-text-secondary hover:text-th-accent"
				>
					<span>{roleName ?? "—"}</span>
					<Pencil className="size-3.5 text-th-text-muted opacity-60 md:opacity-0 md:group-hover:opacity-100" />
				</button>
			)}
			{error && (
				<p className="mt-1 text-xs text-th-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

function InlineEditableBody({ work }: { work: Work }) {
	const updateWork = useWSStore((s) => s.actions.updateWork);
	const {
		editing,
		setEditing,
		value,
		setValue,
		saving,
		error,
		ref,
		save,
		cancel,
	} = useInlineEdit<HTMLTextAreaElement>({
		initialValue: work.body ?? "",
		onSave: useCallback(
			(trimmed: string) => updateWork({ id: work.id, body: trimmed }),
			[updateWork, work.id],
		),
		allowEmpty: true,
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: ref.current is a mutable ref, not a reactive dependency
	useEffect(() => {
		if (editing && ref.current) {
			autoResizeTextarea(ref.current);
		}
	}, [editing]);

	if (editing) {
		return (
			<div>
				<h3 className="mb-1 text-xs font-medium text-th-text-muted uppercase">
					Description
				</h3>
				<textarea
					ref={ref}
					value={value}
					onChange={(e) => {
						setValue(e.target.value);
						autoResizeTextarea(e.target);
					}}
					onKeyDown={(e) => {
						if (e.key === "Escape") cancel();
					}}
					disabled={saving}
					placeholder="Add description..."
					rows={3}
					className="w-full resize-none rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none"
				/>
				<div className="mt-2 flex items-center gap-2">
					<button
						type="button"
						onClick={save}
						disabled={saving}
						className="min-h-[44px] rounded-lg bg-th-accent px-4 text-sm font-medium text-th-accent-text disabled:opacity-50"
					>
						{saving ? "Saving..." : "Save"}
					</button>
					<button
						type="button"
						onClick={cancel}
						disabled={saving}
						className="min-h-[44px] rounded-lg px-4 text-sm text-th-text-muted hover:bg-th-bg-tertiary"
					>
						Cancel
					</button>
				</div>
				{error && (
					<p className="mt-1 text-xs text-th-error" role="alert">
						{error}
					</p>
				)}
			</div>
		);
	}

	if (!work.body) {
		return (
			<div>
				<h3 className="mb-1 text-xs font-medium text-th-text-muted uppercase">
					Description
				</h3>
				<button
					type="button"
					onClick={() => setEditing(true)}
					className="min-h-[44px] w-full rounded-lg border border-dashed border-th-border px-3 text-left text-sm text-th-text-muted hover:border-th-text-muted hover:text-th-text-secondary"
				>
					Add description...
				</button>
			</div>
		);
	}

	return (
		<div>
			<div className="group flex items-center justify-between mb-1">
				<h3 className="text-xs font-medium text-th-text-muted uppercase">
					Description
				</h3>
				<button
					type="button"
					onClick={() => setEditing(true)}
					className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-th-text-muted opacity-60 transition-opacity hover:bg-th-bg-tertiary hover:text-th-text-primary md:opacity-0 md:group-hover:opacity-100"
					aria-label="Edit description"
				>
					<Pencil className="size-3.5" />
				</button>
			</div>
			<div className="rounded-lg bg-th-bg-secondary px-3 py-2">
				<MarkdownContent content={work.body} />
			</div>
		</div>
	);
}

function ChildrenSection({
	storyId,
	tasks,
	roleNameMap,
	onOpenWorkDetail,
	onNavigateToSession,
}: {
	storyId: string;
	tasks: Work[];
	roleNameMap: Map<string, string>;
	onOpenWorkDetail: (workId: string) => void;
	onNavigateToSession: (sessionId: string) => void;
}) {
	const doneTasks = tasks.filter(
		(t) => t.status === "done" || t.status === "closed",
	).length;

	return (
		<div>
			<h3 className="mb-1 text-xs font-medium text-th-text-muted uppercase">
				Tasks{" "}
				{tasks.length > 0 && (
					<span>
						({doneTasks}/{tasks.length})
					</span>
				)}
			</h3>
			{tasks.length === 0 ? (
				<p className="py-2 text-sm text-th-text-muted">No tasks yet</p>
			) : (
				<div className="space-y-0.5">
					{tasks.map((child) => (
						<ChildRow
							key={child.id}
							work={child}
							roleNameMap={roleNameMap}
							onOpenWorkDetail={onOpenWorkDetail}
							onNavigateToSession={onNavigateToSession}
						/>
					))}
				</div>
			)}
			<div className="mt-1">
				<CreateWorkForm type="task" parentId={storyId} />
			</div>
		</div>
	);
}

function ChildRow({
	work,
	roleNameMap,
	onOpenWorkDetail,
	onNavigateToSession,
}: {
	work: Work;
	roleNameMap: Map<string, string>;
	onOpenWorkDetail: (workId: string) => void;
	onNavigateToSession: (sessionId: string) => void;
}) {
	const roleName = work.agent_role_id
		? (roleNameMap.get(work.agent_role_id) ?? null)
		: null;
	const isNeedsInput = work.status === "needs_input";
	const isStopped = work.status === "stopped";

	return (
		<div
			className={`group flex min-h-[44px] items-center gap-2 rounded-lg px-2 hover:bg-th-bg-tertiary ${isNeedsInput ? "border-l-2 border-th-warning bg-th-warning/5" : isStopped ? "border-l-2 border-th-error bg-th-error/5" : ""}`}
		>
			<StatusIcon status={work.status} />
			<button
				type="button"
				onClick={() => onOpenWorkDetail(work.id)}
				className="min-w-0 flex-1 truncate text-left text-sm text-th-text-primary hover:text-th-accent"
			>
				{work.title}
			</button>
			<span className="shrink-0 text-xs text-th-text-muted">
				{roleName ?? "—"}
			</span>
			{work.session_id && (
				<button
					type="button"
					onClick={() => onNavigateToSession(work.session_id ?? "")}
					className="flex min-h-[44px] shrink-0 items-center rounded-lg px-2 text-xs text-th-accent hover:bg-th-bg-tertiary"
				>
					Chat
				</button>
			)}
			{((work.status === "open" && !work.session_id) ||
				work.status === "stopped") && <StartButton workId={work.id} iconOnly />}
		</div>
	);
}

function CommentsSection({ comments }: { comments: Comment[] }) {
	if (comments.length === 0) {
		return (
			<div>
				<h3 className="mb-1 text-xs font-medium text-th-text-muted uppercase">
					Comments
				</h3>
				<p className="py-2 text-sm text-th-text-muted">No comments yet</p>
			</div>
		);
	}

	return (
		<div>
			<h3 className="mb-1 text-xs font-medium text-th-text-muted uppercase">
				Comments ({comments.length})
			</h3>
			<div className="space-y-3">
				{comments.map((comment) => (
					<div
						key={comment.id}
						className="rounded-lg bg-th-bg-secondary px-3 py-2"
					>
						<MarkdownContent content={comment.body} />
						<p className="mt-1.5 text-xs text-th-text-muted">
							{formatCommentDate(comment.created_at)}
						</p>
					</div>
				))}
			</div>
		</div>
	);
}

function DeleteSection({
	work,
	childCount,
	onBack,
}: {
	work: Work;
	childCount: number;
	onBack: () => void;
}) {
	const deleteWork = useWSStore((s) => s.actions.deleteWork);
	const [showConfirm, setShowConfirm] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleDelete = useCallback(async () => {
		try {
			await deleteWork(work.id);
			setShowConfirm(false);
			onBack();
		} catch (err) {
			setError(
				`Failed to delete: ${err instanceof Error ? err.message : String(err)}`,
			);
			setShowConfirm(false);
		}
	}, [deleteWork, work.id, onBack]);

	if (work.status === "closed") return null;

	const typeLabel = work.type === "story" ? "Story" : "Task";
	const confirmMessage =
		childCount > 0
			? `Delete "${work.title}" and its ${childCount} child task${childCount > 1 ? "s" : ""}? This cannot be undone.`
			: `Delete "${work.title}"? This cannot be undone.`;

	return (
		<div className="border-t border-th-border pt-5">
			<button
				type="button"
				onClick={() => setShowConfirm(true)}
				className="flex min-h-[44px] items-center gap-2 rounded-lg px-3 text-sm text-th-error hover:bg-th-error/10"
			>
				<Trash2 className="size-4" />
				Delete {typeLabel}
			</button>
			{error && (
				<p className="mt-1 px-3 text-xs text-th-error" role="alert">
					{error}
				</p>
			)}
			{showConfirm && (
				<ConfirmDialog
					title={`Delete ${typeLabel}`}
					message={confirmMessage}
					confirmLabel="Delete"
					variant="danger"
					onConfirm={handleDelete}
					onCancel={() => setShowConfirm(false)}
				/>
			)}
		</div>
	);
}

function formatCommentDate(dateString: string): string {
	const date = new Date(dateString);
	const now = new Date();
	if (date.toDateString() === now.toDateString()) {
		return date.toLocaleTimeString(undefined, {
			hour: "2-digit",
			minute: "2-digit",
		});
	}
	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}
