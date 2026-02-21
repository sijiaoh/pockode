import { AlertCircle, Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { useAgentRoleSubscription } from "../../hooks/useAgentRoleSubscription";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { useWSStore } from "../../lib/wsStore";
import ConfirmDialog from "../common/ConfirmDialog";
import BackToChatButton from "../ui/BackToChatButton";

interface Props {
	onBack: () => void;
	onOpenAgentRoleDetail: (roleId: string) => void;
}

export default function AgentRoleListOverlay({
	onBack,
	onOpenAgentRoleDetail,
}: Props) {
	useAgentRoleSubscription(true);

	const roles = useAgentRoleStore((s) => s.roles);
	const isLoading = useAgentRoleStore((s) => s.isLoading);
	const error = useAgentRoleStore((s) => s.error);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex items-center gap-1.5 border-b border-th-border bg-th-bg-secondary px-2 py-2">
				<BackToChatButton onClick={onBack} />
				<h1 className="flex-1 px-2 text-sm font-bold text-th-text-primary">
					Agent Roles
				</h1>
			</header>

			<div className="min-h-0 flex-1 overflow-auto p-2">
				{isLoading ? (
					<div className="flex items-center justify-center py-8">
						<Loader2 className="size-5 animate-spin text-th-text-muted" />
					</div>
				) : error ? (
					<div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-th-error">
						<AlertCircle className="size-5" />
						<p>{error}</p>
					</div>
				) : roles.length === 0 ? (
					<div className="py-8 text-center text-sm text-th-text-muted">
						No agent roles yet
					</div>
				) : (
					<div className="space-y-1">
						{roles.map((role) => (
							<RoleRow
								key={role.id}
								roleId={role.id}
								name={role.name}
								onOpenDetail={onOpenAgentRoleDetail}
							/>
						))}
					</div>
				)}
			</div>

			<div className="border-t border-th-border p-2">
				<CreateRoleButton />
			</div>
		</div>
	);
}

function RoleRow({
	roleId,
	name,
	onOpenDetail,
}: {
	roleId: string;
	name: string;
	onOpenDetail: (roleId: string) => void;
}) {
	const deleteAgentRole = useWSStore((s) => s.actions.deleteAgentRole);
	const [showDelete, setShowDelete] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleDelete = useCallback(async () => {
		try {
			await deleteAgentRole(roleId);
			setShowDelete(false);
		} catch (err) {
			setError(
				`Failed to delete: ${err instanceof Error ? err.message : String(err)}`,
			);
			setShowDelete(false);
		}
	}, [deleteAgentRole, roleId]);

	return (
		<>
			<div className="group flex min-h-[44px] items-center gap-1.5 rounded-lg px-2 hover:bg-th-bg-tertiary">
				<button
					type="button"
					onClick={() => onOpenDetail(roleId)}
					className="min-w-0 flex-1 truncate text-left text-sm text-th-text-primary hover:text-th-accent"
				>
					{name}
				</button>

				<button
					type="button"
					onClick={() => setShowDelete(true)}
					className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg text-th-text-muted transition-opacity hover:text-th-error md:opacity-0 md:group-hover:opacity-100"
					aria-label="Delete"
				>
					<Trash2 className="size-4" />
				</button>
			</div>

			{error && (
				<p className="px-1.5 py-1 text-xs text-th-error" role="alert">
					{error}
				</p>
			)}

			{showDelete && (
				<ConfirmDialog
					title="Delete agent role"
					message={`Delete "${name}"?`}
					confirmLabel="Delete"
					variant="danger"
					onConfirm={handleDelete}
					onCancel={() => setShowDelete(false)}
				/>
			)}
		</>
	);
}

function CreateRoleButton() {
	const [isCreating, setIsCreating] = useState(false);
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const createAgentRole = useWSStore((s) => s.actions.createAgentRole);

	const handleSubmit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			const trimmed = name.trim();
			if (!trimmed || isSubmitting) return;

			setError(null);
			setIsSubmitting(true);
			try {
				await createAgentRole({ name: trimmed, role_prompt: "" });
				setName("");
				setIsCreating(false);
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to create role");
			} finally {
				setIsSubmitting(false);
			}
		},
		[name, createAgentRole, isSubmitting],
	);

	if (!isCreating) {
		return (
			<button
				type="button"
				onClick={() => setIsCreating(true)}
				className="flex min-h-[44px] w-full items-center gap-2 rounded-lg px-3 text-sm text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-primary"
			>
				<Plus className="size-4" />
				Add Role
			</button>
		);
	}

	return (
		<div className="rounded-lg bg-th-bg-secondary p-3">
			<form onSubmit={handleSubmit} className="space-y-2">
				<input
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="Role name"
					className="min-h-[44px] w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none"
					// biome-ignore lint/a11y/noAutofocus: inline creation form
					autoFocus
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							setIsCreating(false);
							setName("");
							setError(null);
						}
					}}
				/>
				<div className="flex gap-2">
					<button
						type="submit"
						disabled={!name.trim() || isSubmitting}
						className="min-h-[44px] flex-1 rounded-lg bg-th-accent px-3 text-sm font-medium text-th-accent-text disabled:opacity-50"
					>
						{isSubmitting ? "Adding..." : "Add"}
					</button>
					<button
						type="button"
						onClick={() => {
							setIsCreating(false);
							setName("");
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
