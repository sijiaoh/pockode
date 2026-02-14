import { Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useRoles } from "../../hooks/useRoles";
import { useWSStore } from "../../lib/wsStore";
import type { AgentRole } from "../../types/message";
import ConfirmDialog from "../common/ConfirmDialog";

interface Props {
	onClose: () => void;
}

function AgentSettingsOverlay({ onClose }: Props) {
	const titleId = useId();
	const { roles, addRole, updateRole, removeRole } = useRoles();
	const createRoleAction = useWSStore((s) => s.actions.createRole);
	const updateRoleAction = useWSStore((s) => s.actions.updateRole);
	const deleteRoleAction = useWSStore((s) => s.actions.deleteRole);

	const [editingRole, setEditingRole] = useState<AgentRole | null>(null);
	const [isCreating, setIsCreating] = useState(false);
	const [deletingRole, setDeletingRole] = useState<AgentRole | null>(null);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				if (editingRole || isCreating) {
					setEditingRole(null);
					setIsCreating(false);
				} else {
					onClose();
				}
			}
		};

		const originalOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";

		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			document.body.style.overflow = originalOverflow;
		};
	}, [onClose, editingRole, isCreating]);

	const handleCreate = async (name: string, systemPrompt: string) => {
		const role = await createRoleAction({ name, system_prompt: systemPrompt });
		addRole(role);
		setIsCreating(false);
	};

	const handleUpdate = async (
		roleId: string,
		name: string,
		systemPrompt: string,
	) => {
		const role = await updateRoleAction({
			role_id: roleId,
			name,
			system_prompt: systemPrompt,
		});
		updateRole(role);
		setEditingRole(null);
	};

	const handleDelete = async () => {
		if (!deletingRole) return;
		await deleteRoleAction(deletingRole.id);
		removeRole(deletingRole.id);
		setDeletingRole(null);
	};

	const stopEvent = (e: React.SyntheticEvent) => e.stopPropagation();

	return createPortal(
		/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled in useEffect */
		<div
			className="fixed inset-0 z-[70] flex items-center justify-center bg-th-bg-overlay"
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
			onClick={stopEvent}
			onMouseDown={stopEvent}
		>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: backdrop */}
			<div className="absolute inset-0" onClick={onClose} />
			<div className="relative mx-4 w-full max-w-lg max-h-[80vh] flex flex-col rounded-lg bg-th-bg-secondary shadow-xl">
				<div className="flex items-center justify-between p-4 border-b border-th-border">
					<h2 id={titleId} className="text-lg font-bold text-th-text-primary">
						Agent Roles
					</h2>
					<button
						type="button"
						onClick={onClose}
						className="p-1 rounded hover:bg-th-bg-tertiary text-th-text-muted"
					>
						<X className="h-5 w-5" />
					</button>
				</div>

				<div className="flex-1 overflow-y-auto p-4">
					<div className="space-y-3">
						{roles.map((role) =>
							editingRole?.id === role.id ? (
								<RoleEditor
									key={role.id}
									role={role}
									onSave={(name, prompt) => handleUpdate(role.id, name, prompt)}
									onCancel={() => setEditingRole(null)}
								/>
							) : (
								<RoleItem
									key={role.id}
									role={role}
									onEdit={() => setEditingRole(role)}
									onDelete={() => setDeletingRole(role)}
								/>
							),
						)}

						{isCreating ? (
							<RoleEditor
								onSave={handleCreate}
								onCancel={() => setIsCreating(false)}
							/>
						) : (
							<button
								type="button"
								onClick={() => setIsCreating(true)}
								className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-th-border p-3 text-sm text-th-text-muted hover:border-th-accent hover:text-th-accent transition-colors"
							>
								<Plus className="h-4 w-4" />
								Add Role
							</button>
						)}
					</div>
				</div>
			</div>

			{deletingRole && (
				<ConfirmDialog
					title="Delete Role"
					message={`Are you sure you want to delete "${deletingRole.name}"? This action cannot be undone.`}
					confirmLabel="Delete"
					variant="danger"
					onConfirm={handleDelete}
					onCancel={() => setDeletingRole(null)}
				/>
			)}
		</div>,
		document.body,
	);
}

interface RoleItemProps {
	role: AgentRole;
	onEdit: () => void;
	onDelete: () => void;
}

function RoleItem({ role, onEdit, onDelete }: RoleItemProps) {
	return (
		<div className="rounded-lg border border-th-border bg-th-bg-primary p-3">
			<div className="flex items-start justify-between">
				<div className="min-w-0 flex-1">
					<h3 className="text-sm font-medium text-th-text-primary">
						{role.name}
					</h3>
					<p className="mt-1 text-xs text-th-text-muted line-clamp-2">
						{role.system_prompt || "No system prompt"}
					</p>
				</div>
				<div className="flex items-center gap-1 ml-2">
					<button
						type="button"
						onClick={onEdit}
						className="p-1.5 rounded hover:bg-th-bg-tertiary text-th-text-muted"
						title="Edit role"
					>
						<Pencil className="h-4 w-4" />
					</button>
					<button
						type="button"
						onClick={onDelete}
						className="p-1.5 rounded hover:bg-th-bg-tertiary text-th-text-muted hover:text-red-500"
						title="Delete role"
					>
						<Trash2 className="h-4 w-4" />
					</button>
				</div>
			</div>
		</div>
	);
}

interface RoleEditorProps {
	role?: AgentRole;
	onSave: (name: string, systemPrompt: string) => void;
	onCancel: () => void;
}

function RoleEditor({ role, onSave, onCancel }: RoleEditorProps) {
	const [name, setName] = useState(role?.name ?? "");
	const [systemPrompt, setSystemPrompt] = useState(role?.system_prompt ?? "");

	const isValid = name.trim().length > 0;

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!isValid) return;
		onSave(name.trim(), systemPrompt.trim());
	};

	return (
		<form
			onSubmit={handleSubmit}
			className="rounded-lg border border-th-accent bg-th-bg-primary p-3 space-y-3"
		>
			<input
				type="text"
				value={name}
				onChange={(e) => setName(e.target.value)}
				placeholder="Role name"
				className="w-full rounded border border-th-border bg-th-bg-secondary px-2 py-1.5 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none"
			/>
			<textarea
				value={systemPrompt}
				onChange={(e) => setSystemPrompt(e.target.value)}
				placeholder="System prompt..."
				rows={3}
				className="w-full rounded border border-th-border bg-th-bg-secondary px-2 py-1.5 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none resize-none"
			/>
			<div className="flex justify-end gap-2">
				<button
					type="button"
					onClick={onCancel}
					className="px-3 py-1 text-sm text-th-text-muted hover:text-th-text-primary"
				>
					Cancel
				</button>
				<button
					type="submit"
					disabled={!isValid}
					className="px-3 py-1 text-sm bg-th-accent text-th-accent-text rounded hover:bg-th-accent-hover disabled:opacity-50"
				>
					Save
				</button>
			</div>
		</form>
	);
}

export default AgentSettingsOverlay;
