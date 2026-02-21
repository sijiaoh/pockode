import {
	AlertCircle,
	ArrowLeft,
	Check,
	Loader2,
	Pencil,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentRoleSubscription } from "../../hooks/useAgentRoleSubscription";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { useWSStore } from "../../lib/wsStore";
import type { AgentRole } from "../../types/agentRole";
import ConfirmDialog from "../common/ConfirmDialog";

interface Props {
	roleId: string;
	onBack: () => void;
}

export default function AgentRoleDetailOverlay({ roleId, onBack }: Props) {
	useAgentRoleSubscription(true);

	const roles = useAgentRoleStore((s) => s.roles);
	const role = useMemo(
		() => roles.find((r) => r.id === roleId),
		[roles, roleId],
	);

	if (!role) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<DetailHeader onBack={onBack} />
				<div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-th-text-muted">
					<AlertCircle className="size-5" />
					<p>Agent role not found</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<DetailHeader onBack={onBack} />
			<div className="min-h-0 flex-1 overflow-auto">
				<div className="space-y-5 p-4">
					<InlineEditableName role={role} />
					<InlineEditableRolePrompt role={role} />
					<DeleteSection role={role} onDeleted={onBack} />
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
				aria-label="Back to agent roles"
			>
				<ArrowLeft className="h-5 w-5" aria-hidden="true" />
			</button>
			<h1 className="flex-1 px-2 text-sm font-bold text-th-text-primary">
				Agent Role
			</h1>
		</header>
	);
}

function InlineEditableName({ role }: { role: AgentRole }) {
	const updateAgentRole = useWSStore((s) => s.actions.updateAgentRole);
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(role.name);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!editing) setValue(role.name);
	}, [role.name, editing]);

	useEffect(() => {
		if (editing) inputRef.current?.focus();
	}, [editing]);

	const save = useCallback(async () => {
		const trimmed = value.trim();
		if (!trimmed || trimmed === role.name) {
			setEditing(false);
			return;
		}
		setError(null);
		setSaving(true);
		try {
			await updateAgentRole({ id: role.id, name: trimmed });
			setEditing(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save");
		} finally {
			setSaving(false);
		}
	}, [value, role.id, role.name, updateAgentRole]);

	const cancel = useCallback(() => {
		setValue(role.name);
		setEditing(false);
		setError(null);
	}, [role.name]);

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
				{role.name}
			</h2>
			<button
				type="button"
				onClick={() => setEditing(true)}
				className="shrink-0 rounded p-1 text-th-text-muted opacity-0 transition-opacity hover:bg-th-bg-tertiary hover:text-th-text-primary group-hover:opacity-100"
				aria-label="Edit name"
			>
				<Pencil className="size-3.5" />
			</button>
		</div>
	);
}

function InlineEditableRolePrompt({ role }: { role: AgentRole }) {
	const updateAgentRole = useWSStore((s) => s.actions.updateAgentRole);
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(role.role_prompt);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (!editing) setValue(role.role_prompt);
	}, [role.role_prompt, editing]);

	useEffect(() => {
		if (editing && textareaRef.current) {
			textareaRef.current.focus();
			autoResize(textareaRef.current);
		}
	}, [editing]);

	const save = useCallback(async () => {
		const trimmed = value.trim();
		if (trimmed === role.role_prompt.trim()) {
			setEditing(false);
			return;
		}
		setError(null);
		setSaving(true);
		try {
			await updateAgentRole({ id: role.id, role_prompt: trimmed });
			setEditing(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save");
		} finally {
			setSaving(false);
		}
	}, [value, role.id, role.role_prompt, updateAgentRole]);

	const cancel = useCallback(() => {
		setValue(role.role_prompt);
		setEditing(false);
		setError(null);
	}, [role.role_prompt]);

	if (editing) {
		return (
			<div>
				<h3 className="mb-1.5 text-xs font-medium text-th-text-muted uppercase">
					Role Prompt
				</h3>
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
					placeholder="Enter role prompt..."
					rows={6}
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

	if (!role.role_prompt) {
		return (
			<div>
				<h3 className="mb-1.5 text-xs font-medium text-th-text-muted uppercase">
					Role Prompt
				</h3>
				<button
					type="button"
					onClick={() => setEditing(true)}
					className="w-full rounded border border-dashed border-th-border px-3 py-3 text-left text-sm text-th-text-muted hover:border-th-text-muted hover:text-th-text-secondary"
				>
					Add role prompt...
				</button>
			</div>
		);
	}

	return (
		<div>
			<h3 className="mb-1.5 text-xs font-medium text-th-text-muted uppercase">
				Role Prompt
			</h3>
			<div className="group relative">
				<div className="whitespace-pre-wrap rounded bg-th-bg-secondary px-3 py-2 text-sm text-th-text-secondary">
					{role.role_prompt}
				</div>
				<button
					type="button"
					onClick={() => setEditing(true)}
					className="absolute top-2 right-2 rounded p-1 text-th-text-muted opacity-0 transition-opacity hover:bg-th-bg-tertiary hover:text-th-text-primary group-hover:opacity-100"
					aria-label="Edit role prompt"
				>
					<Pencil className="size-3.5" />
				</button>
			</div>
		</div>
	);
}

function DeleteSection({
	role,
	onDeleted,
}: {
	role: AgentRole;
	onDeleted: () => void;
}) {
	const deleteAgentRole = useWSStore((s) => s.actions.deleteAgentRole);
	const [showConfirm, setShowConfirm] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleDelete = useCallback(async () => {
		try {
			await deleteAgentRole(role.id);
			onDeleted();
		} catch (err) {
			setError(
				`Failed to delete: ${err instanceof Error ? err.message : String(err)}`,
			);
			setShowConfirm(false);
		}
	}, [deleteAgentRole, role.id, onDeleted]);

	return (
		<div className="border-t border-th-border pt-4">
			<button
				type="button"
				onClick={() => setShowConfirm(true)}
				className="rounded px-3 py-1.5 text-xs text-th-error hover:bg-th-error/10"
			>
				Delete Role
			</button>
			{error && (
				<p className="mt-1 text-xs text-th-error" role="alert">
					{error}
				</p>
			)}
			{showConfirm && (
				<ConfirmDialog
					title="Delete agent role"
					message={`Delete "${role.name}"? This cannot be undone.`}
					confirmLabel="Delete"
					variant="danger"
					onConfirm={handleDelete}
					onCancel={() => setShowConfirm(false)}
				/>
			)}
		</div>
	);
}

function autoResize(el: HTMLTextAreaElement) {
	el.style.height = "auto";
	el.style.height = `${el.scrollHeight}px`;
}
