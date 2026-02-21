import {
	AlertCircle,
	ArrowLeft,
	Check,
	Loader2,
	Pencil,
	Play,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentRoleSubscription } from "../../hooks/useAgentRoleSubscription";
import { useWorkSubscription } from "../../hooks/useWorkSubscription";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { useWorkStore } from "../../lib/workStore";
import { useWSStore } from "../../lib/wsStore";
import type { Work, WorkStatus } from "../../types/work";
import StatusIcon from "../ui/StatusIcon";

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
	useWorkSubscription(true);
	useAgentRoleSubscription(true);

	const works = useWorkStore((s) => s.works);
	const work = useMemo(
		() => works.find((w) => w.id === workId),
		[works, workId],
	);
	const children = useMemo(
		() => works.filter((w) => w.parent_id === workId),
		[works, workId],
	);
	const parent = useMemo(
		() => (work?.parent_id ? works.find((w) => w.id === work.parent_id) : null),
		[works, work],
	);

	if (!work) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<DetailHeader onBack={onBack} />
				<div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-th-text-muted">
					<AlertCircle className="size-5" />
					<p>Work item not found</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<DetailHeader onBack={onBack} />
			<div className="min-h-0 flex-1 overflow-auto">
				<div className="space-y-5 p-4">
					<div className="flex items-start gap-2">
						<StatusIcon status={work.status} className="mt-1 shrink-0" />
						<div className="min-w-0 flex-1">
							<InlineEditableTitle work={work} />
							{parent && (
								<button
									type="button"
									onClick={() => onOpenWorkDetail(parent.id)}
									className="mt-1 text-xs text-th-text-muted hover:text-th-accent"
								>
									{parent.title}
								</button>
							)}
						</div>
					</div>

					<InlineEditableBody work={work} />

					<MetadataSection
						work={work}
						onNavigateToSession={onNavigateToSession}
					/>

					{work.type === "story" && (
						<ChildrenSection
							tasks={children}
							onOpenWorkDetail={onOpenWorkDetail}
							onNavigateToSession={onNavigateToSession}
						/>
					)}
				</div>
			</div>
		</div>
	);
}

function DetailHeader({ onBack }: { onBack: () => void }) {
	return (
		<header className="flex items-center gap-1.5 border-b border-th-border bg-th-bg-secondary px-2 py-2">
			<button
				type="button"
				onClick={onBack}
				className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-th-border bg-th-bg-tertiary p-2 text-th-text-secondary transition-all hover:border-th-border-focus hover:text-th-text-primary active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
				aria-label="Back to work list"
			>
				<ArrowLeft className="h-5 w-5" aria-hidden="true" />
			</button>
			<h1 className="flex-1 px-2 text-sm font-bold text-th-text-primary">
				Detail
			</h1>
		</header>
	);
}

function InlineEditableTitle({ work }: { work: Work }) {
	const updateWork = useWSStore((s) => s.actions.updateWork);
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(work.title);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!editing) setValue(work.title);
	}, [work.title, editing]);

	useEffect(() => {
		if (editing) inputRef.current?.focus();
	}, [editing]);

	const save = useCallback(async () => {
		const trimmed = value.trim();
		if (!trimmed || trimmed === work.title) {
			setEditing(false);
			return;
		}
		setError(null);
		setSaving(true);
		try {
			await updateWork({ id: work.id, title: trimmed });
			setEditing(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save");
		} finally {
			setSaving(false);
		}
	}, [value, work.id, work.title, updateWork]);

	const cancel = useCallback(() => {
		setValue(work.title);
		setEditing(false);
		setError(null);
	}, [work.title]);

	if (editing) {
		return (
			<div>
				<div className="flex items-center gap-1">
					<input
						ref={inputRef}
						type="text"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") save();
							if (e.key === "Escape") cancel();
						}}
						disabled={saving}
						className="min-w-0 flex-1 rounded border border-th-border bg-th-bg-primary px-2 py-1 text-base font-semibold text-th-text-primary focus:border-th-accent focus:outline-none"
					/>
					<button
						type="button"
						onClick={save}
						disabled={saving || !value.trim()}
						className="rounded p-1 text-th-success hover:bg-th-bg-tertiary disabled:opacity-50"
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
						className="rounded p-1 text-th-text-muted hover:bg-th-bg-tertiary"
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
			<h2 className="min-w-0 flex-1 text-base font-semibold text-th-text-primary">
				{work.title}
			</h2>
			<button
				type="button"
				onClick={() => setEditing(true)}
				className="shrink-0 rounded p-1 text-th-text-muted opacity-0 transition-opacity hover:bg-th-bg-tertiary hover:text-th-text-primary group-hover:opacity-100"
				aria-label="Edit title"
			>
				<Pencil className="size-3.5" />
			</button>
		</div>
	);
}

function InlineEditableBody({ work }: { work: Work }) {
	const updateWork = useWSStore((s) => s.actions.updateWork);
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(work.body ?? "");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (!editing) setValue(work.body ?? "");
	}, [work.body, editing]);

	useEffect(() => {
		if (editing && textareaRef.current) {
			textareaRef.current.focus();
			autoResize(textareaRef.current);
		}
	}, [editing]);

	const save = useCallback(async () => {
		const trimmed = value.trim();
		if (trimmed === (work.body ?? "").trim()) {
			setEditing(false);
			return;
		}
		setError(null);
		setSaving(true);
		try {
			await updateWork({ id: work.id, body: trimmed });
			setEditing(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save");
		} finally {
			setSaving(false);
		}
	}, [value, work.id, work.body, updateWork]);

	const cancel = useCallback(() => {
		setValue(work.body ?? "");
		setEditing(false);
		setError(null);
	}, [work.body]);

	if (editing) {
		return (
			<div>
				<textarea
					ref={textareaRef}
					value={value}
					onChange={(e) => {
						setValue(e.target.value);
						autoResize(e.target);
					}}
					onKeyDown={(e) => {
						if (e.key === "Escape") cancel();
					}}
					disabled={saving}
					placeholder="Add description..."
					rows={3}
					className="w-full resize-none rounded border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none"
				/>
				<div className="mt-1.5 flex items-center gap-1.5">
					<button
						type="button"
						onClick={save}
						disabled={saving}
						className="rounded bg-th-accent px-3 py-1 text-xs text-th-accent-text disabled:opacity-50"
					>
						{saving ? "Saving..." : "Save"}
					</button>
					<button
						type="button"
						onClick={cancel}
						disabled={saving}
						className="rounded px-3 py-1 text-xs text-th-text-muted hover:bg-th-bg-tertiary"
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
			<button
				type="button"
				onClick={() => setEditing(true)}
				className="w-full rounded border border-dashed border-th-border px-3 py-3 text-left text-sm text-th-text-muted hover:border-th-text-muted hover:text-th-text-secondary"
			>
				Add description...
			</button>
		);
	}

	return (
		<div className="group relative">
			<div className="whitespace-pre-wrap rounded bg-th-bg-secondary px-3 py-2 text-sm text-th-text-secondary">
				{work.body}
			</div>
			<button
				type="button"
				onClick={() => setEditing(true)}
				className="absolute top-2 right-2 rounded p-1 text-th-text-muted opacity-0 transition-opacity hover:bg-th-bg-tertiary hover:text-th-text-primary group-hover:opacity-100"
				aria-label="Edit description"
			>
				<Pencil className="size-3.5" />
			</button>
		</div>
	);
}

function MetadataSection({
	work,
	onNavigateToSession,
}: {
	work: Work;
	onNavigateToSession: (sessionId: string) => void;
}) {
	const startWork = useWSStore((s) => s.actions.startWork);
	const updateWork = useWSStore((s) => s.actions.updateWork);
	const roles = useAgentRoleStore((s) => s.roles);
	const [isStarting, setIsStarting] = useState(false);
	const [editingRole, setEditingRole] = useState(false);
	const [savingRole, setSavingRole] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const roleName = useMemo(() => {
		if (!work.agent_role_id) return null;
		return roles.find((r) => r.id === work.agent_role_id)?.name ?? null;
	}, [work.agent_role_id, roles]);

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
		<div className="space-y-2">
			<div className="flex items-center gap-2 text-xs text-th-text-muted">
				<span className="w-14">Status</span>
				<StatusBadge status={work.status} />
			</div>
			<div className="flex items-center gap-2 text-xs text-th-text-muted">
				<span className="w-14">Type</span>
				<span className="text-th-text-secondary">{work.type}</span>
			</div>
			<div className="flex items-center gap-2 text-xs text-th-text-muted">
				<span className="w-14">Role</span>
				{editingRole ? (
					<div className="flex items-center gap-1">
						<select
							value={work.agent_role_id ?? ""}
							onChange={(e) => handleRoleChange(e.target.value)}
							onBlur={() => {
								if (!savingRole) setEditingRole(false);
							}}
							disabled={savingRole}
							className="rounded border border-th-border bg-th-bg-primary px-1.5 py-0.5 text-xs text-th-text-primary focus:border-th-accent focus:outline-none"
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
							<Loader2 className="size-3 animate-spin text-th-text-muted" />
						)}
					</div>
				) : (
					<button
						type="button"
						onClick={() => setEditingRole(true)}
						className="group flex items-center gap-1 text-th-text-secondary hover:text-th-accent"
					>
						<span>{roleName ?? "—"}</span>
						<Pencil className="size-3 text-th-text-muted opacity-0 group-hover:opacity-100" />
					</button>
				)}
			</div>
			<div className="flex items-center gap-2">
				{work.status === "open" && (
					<button
						type="button"
						onClick={handleStart}
						disabled={isStarting}
						className="flex items-center gap-1 rounded bg-th-accent px-2.5 py-1 text-xs text-th-accent-text disabled:opacity-50"
					>
						{isStarting ? (
							<Loader2 className="size-3 animate-spin" />
						) : (
							<Play className="size-3" />
						)}
						Start
					</button>
				)}
				{work.session_id && (
					<button
						type="button"
						onClick={() => onNavigateToSession(work.session_id ?? "")}
						className="rounded px-2.5 py-1 text-xs text-th-accent hover:bg-th-bg-tertiary"
					>
						Open Chat
					</button>
				)}
			</div>
			{error && (
				<p className="text-xs text-th-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

function ChildrenSection({
	tasks,
	onOpenWorkDetail,
	onNavigateToSession,
}: {
	tasks: Work[];
	onOpenWorkDetail: (workId: string) => void;
	onNavigateToSession: (sessionId: string) => void;
}) {
	if (tasks.length === 0) {
		return (
			<div>
				<h3 className="mb-2 text-xs font-medium text-th-text-muted uppercase">
					Tasks
				</h3>
				<p className="text-sm text-th-text-muted">No tasks yet</p>
			</div>
		);
	}

	return (
		<div>
			<h3 className="mb-2 text-xs font-medium text-th-text-muted uppercase">
				Tasks ({tasks.length})
			</h3>
			<div className="space-y-0.5">
				{tasks.map((child) => (
					<ChildRow
						key={child.id}
						work={child}
						onOpenWorkDetail={onOpenWorkDetail}
						onNavigateToSession={onNavigateToSession}
					/>
				))}
			</div>
		</div>
	);
}

function ChildRow({
	work,
	onOpenWorkDetail,
	onNavigateToSession,
}: {
	work: Work;
	onOpenWorkDetail: (workId: string) => void;
	onNavigateToSession: (sessionId: string) => void;
}) {
	return (
		<div className="group flex min-h-[36px] items-center gap-1.5 rounded px-1.5 hover:bg-th-bg-tertiary">
			<StatusIcon status={work.status} />
			<button
				type="button"
				onClick={() => onOpenWorkDetail(work.id)}
				className="min-w-0 flex-1 truncate text-left text-sm text-th-text-primary hover:text-th-accent"
			>
				{work.title}
			</button>
			{work.session_id && (
				<button
					type="button"
					onClick={() => onNavigateToSession(work.session_id ?? "")}
					className="shrink-0 rounded px-1.5 py-0.5 text-xs text-th-accent hover:bg-th-bg-tertiary"
				>
					Chat
				</button>
			)}
		</div>
	);
}

function StatusBadge({ status }: { status: WorkStatus }) {
	const styles: Record<WorkStatus, string> = {
		open: "bg-th-bg-tertiary text-th-text-muted",
		in_progress: "bg-th-accent/10 text-th-accent",
		done: "bg-th-warning/10 text-th-warning",
		closed: "bg-th-success/10 text-th-success",
	};
	const labels: Record<WorkStatus, string> = {
		open: "Open",
		in_progress: "In Progress",
		done: "Done",
		closed: "Closed",
	};
	return (
		<span className={`rounded-full px-2 py-0.5 text-xs ${styles[status]}`}>
			{labels[status]}
		</span>
	);
}

function autoResize(el: HTMLTextAreaElement) {
	el.style.height = "auto";
	el.style.height = `${el.scrollHeight}px`;
}
