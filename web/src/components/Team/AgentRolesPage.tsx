import { Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useRoles } from "../../hooks/useRoles";
import { useTicketStore } from "../../lib/ticketStore";
import { useWSStore } from "../../lib/wsStore";
import type { AgentRole } from "../../types/message";
import ConfirmDialog from "../common/ConfirmDialog";
import BackToChatButton from "../ui/BackToChatButton";
import RoleEditorOverlay from "./RoleEditorOverlay";

interface Props {
	onBack: () => void;
}

export default function AgentRolesPage({ onBack }: Props) {
	const { roles, addRole, updateRole, removeRole } = useRoles();
	const tickets = useTicketStore((s) => s.tickets);
	const createRoleAction = useWSStore((s) => s.actions.createRole);
	const updateRoleAction = useWSStore((s) => s.actions.updateRole);
	const deleteRoleAction = useWSStore((s) => s.actions.deleteRole);

	const [editorState, setEditorState] = useState<
		{ mode: "edit"; role: AgentRole } | { mode: "create" } | null
	>(null);
	const [deletingRole, setDeletingRole] = useState<AgentRole | null>(null);

	const affectedTicketCount = useMemo(() => {
		if (!deletingRole) return 0;
		return tickets.filter(
			(t) =>
				t.role_id === deletingRole.id &&
				(t.status === "open" || t.status === "in_progress"),
		).length;
	}, [deletingRole, tickets]);

	const handleSave = async (name: string, systemPrompt: string) => {
		if (editorState?.mode === "edit") {
			const role = await updateRoleAction(
				editorState.role.id,
				name,
				systemPrompt,
			);
			updateRole(role);
		} else {
			const role = await createRoleAction(name, systemPrompt);
			addRole(role);
		}
		setEditorState(null);
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
					{roles.map((role) => (
						<RoleItem
							key={role.id}
							role={role}
							onEdit={() => setEditorState({ mode: "edit", role })}
							onDelete={() => setDeletingRole(role)}
						/>
					))}

					<button
						type="button"
						onClick={() => setEditorState({ mode: "create" })}
						className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-th-border p-3 text-sm text-th-text-muted transition-colors hover:border-th-accent hover:text-th-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
					>
						<Plus className="h-4 w-4" />
						Add Role
					</button>
				</div>
			</main>

			{editorState && (
				<RoleEditorOverlay
					role={editorState.mode === "edit" ? editorState.role : undefined}
					onSave={handleSave}
					onCancel={() => setEditorState(null)}
				/>
			)}

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
