import { Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useRoles } from "../../hooks/useRoles";
import { useTicketStore } from "../../lib/ticketStore";
import { useWSStore } from "../../lib/wsStore";
import type { AgentRole } from "../../types/message";
import ConfirmDialog from "../common/ConfirmDialog";
import BackToChatButton from "../ui/BackToChatButton";

interface Props {
	onBack: () => void;
}

export default function AgentRolesPage({ onBack }: Props) {
	const { roles, addRole, updateRole, removeRole } = useRoles();
	const tickets = useTicketStore((s) => s.tickets);
	const createRoleAction = useWSStore((s) => s.actions.createRole);
	const updateRoleAction = useWSStore((s) => s.actions.updateRole);
	const deleteRoleAction = useWSStore((s) => s.actions.deleteRole);

	const [editingRole, setEditingRole] = useState<AgentRole | null>(null);
	const [isCreating, setIsCreating] = useState(false);
	const [deletingRole, setDeletingRole] = useState<AgentRole | null>(null);

	const affectedTicketCount = useMemo(() => {
		if (!deletingRole) return 0;
		return tickets.filter(
			(t) =>
				t.role_id === deletingRole.id &&
				(t.status === "open" || t.status === "in_progress"),
		).length;
	}, [deletingRole, tickets]);

	const handleCreate = async (name: string, systemPrompt: string) => {
		const role = await createRoleAction(name, systemPrompt);
		addRole(role);
		setIsCreating(false);
	};

	const handleUpdate = async (
		roleId: string,
		name: string,
		systemPrompt: string,
	) => {
		const role = await updateRoleAction(roleId, name, systemPrompt);
		updateRole(role);
		setEditingRole(null);
	};

	const handleDelete = async () => {
		if (!deletingRole) return;
		await deleteRoleAction(deletingRole.id);
		removeRole(deletingRole.id);
		setDeletingRole(null);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex items-center gap-1.5 border-b border-th-border bg-th-bg-secondary px-2 py-2">
				<BackToChatButton onClick={onBack} />
				<h1 className="px-2 text-sm font-bold text-th-text-primary">
					Agent Roles
				</h1>
			</header>

			<main className="min-h-0 flex-1 overflow-auto p-4">
				<div className="mx-auto max-w-lg space-y-3">
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
							className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-th-border p-3 text-sm text-th-text-muted transition-colors hover:border-th-accent hover:text-th-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
						>
							<Plus className="h-4 w-4" />
							Add Role
						</button>
					)}
				</div>
			</main>

			{deletingRole && (
				<ConfirmDialog
					title="Delete Role"
					message={
						affectedTicketCount > 0
							? `This role is used by ${affectedTicketCount} active ticket${affectedTicketCount > 1 ? "s" : ""}. Deleting it may cause issues with those tickets.\n\nAre you sure you want to delete "${deletingRole.name}"?`
							: `Are you sure you want to delete "${deletingRole.name}"? This action cannot be undone.`
					}
					confirmLabel="Delete"
					variant="danger"
					onConfirm={handleDelete}
					onCancel={() => setDeletingRole(null)}
				/>
			)}
		</div>
	);
}

interface RoleItemProps {
	role: AgentRole;
	onEdit: () => void;
	onDelete: () => void;
}

function RoleItem({ role, onEdit, onDelete }: RoleItemProps) {
	return (
		<div className="rounded-lg border border-th-border bg-th-bg-secondary p-3">
			<div className="flex items-start justify-between">
				<div className="min-w-0 flex-1">
					<h3 className="text-sm font-medium text-th-text-primary">
						{role.name}
					</h3>
					<p className="mt-1 line-clamp-2 text-xs text-th-text-muted">
						{role.system_prompt || "No system prompt"}
					</p>
				</div>
				<div className="ml-2 flex items-center gap-0.5">
					<button
						type="button"
						onClick={onEdit}
						className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-th-text-muted hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
						title="Edit role"
					>
						<Pencil className="h-5 w-5" />
					</button>
					<button
						type="button"
						onClick={onDelete}
						className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-error focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
						title="Delete role"
					>
						<Trash2 className="h-5 w-5" />
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
			className="space-y-3 rounded-lg border border-th-accent bg-th-bg-secondary p-3"
		>
			<input
				type="text"
				value={name}
				onChange={(e) => setName(e.target.value)}
				placeholder="Role name"
				className="w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none"
			/>
			<textarea
				value={systemPrompt}
				onChange={(e) => setSystemPrompt(e.target.value)}
				placeholder="System prompt..."
				rows={3}
				className="w-full resize-none rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none"
			/>
			<div className="flex justify-end gap-3 pt-2">
				<button
					type="button"
					onClick={onCancel}
					className="rounded-lg bg-th-bg-tertiary px-4 py-2 text-sm text-th-text-primary transition-colors hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
				>
					Cancel
				</button>
				<button
					type="submit"
					disabled={!isValid}
					className="rounded-lg bg-th-accent px-4 py-2 text-sm text-th-accent-text transition-colors hover:bg-th-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent disabled:cursor-not-allowed disabled:opacity-50"
				>
					Save
				</button>
			</div>
		</form>
	);
}
