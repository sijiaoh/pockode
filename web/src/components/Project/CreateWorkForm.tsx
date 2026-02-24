import { Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { useSettingsStore } from "../../lib/settingsStore";
import { useWSStore } from "../../lib/wsStore";
import type { WorkType } from "../../types/work";

interface Props {
	type: WorkType;
	parentId?: string;
}

export default function CreateWorkForm({ type, parentId }: Props) {
	const [isCreating, setIsCreating] = useState(false);
	const [title, setTitle] = useState("");
	const [agentRoleId, setAgentRoleId] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const createWork = useWSStore((s) => s.actions.createWork);
	const roles = useAgentRoleStore((s) => s.roles);
	const defaultRoleId = useSettingsStore(
		(s) => s.settings?.default_agent_role_id ?? "",
	);

	const resolveInitialRole = useCallback((): string => {
		if (roles.length === 1) return roles[0].id;
		if (defaultRoleId && roles.some((r) => r.id === defaultRoleId))
			return defaultRoleId;
		return "";
	}, [roles, defaultRoleId]);

	useEffect(() => {
		if (!agentRoleId) {
			const initial = resolveInitialRole();
			if (initial) setAgentRoleId(initial);
		}
	}, [resolveInitialRole, agentRoleId]);

	const resetForm = useCallback(() => {
		setTitle("");
		setAgentRoleId(resolveInitialRole());
		setError(null);
	}, [resolveInitialRole]);

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
					parent_id: parentId,
					agent_role_id: agentRoleId,
					title: trimmed,
				});
				resetForm();
				setIsCreating(false);
			} catch (err) {
				setError(
					err instanceof Error ? err.message : `Failed to create ${type}`,
				);
			} finally {
				setIsSubmitting(false);
			}
		},
		[title, type, parentId, agentRoleId, createWork, isSubmitting, resetForm],
	);

	const buttonLabel = type === "story" ? "New Story" : "Add Task";

	if (!isCreating) {
		return (
			<button
				type="button"
				onClick={() => setIsCreating(true)}
				className="flex min-h-[44px] w-full items-center gap-2 rounded-lg px-3 text-sm text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-primary"
			>
				<Plus className="size-4" />
				{buttonLabel}
			</button>
		);
	}

	if (roles.length === 0) {
		return (
			<div className="rounded-lg bg-th-bg-secondary p-3 text-xs text-th-text-muted">
				<p>No agent roles registered.</p>
				{type === "story" && (
					<p className="mt-1">
						Create a role in{" "}
						<span className="font-medium text-th-text-secondary">
							Agent Roles
						</span>{" "}
						first.
					</p>
				)}
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
							resetForm();
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
						{isSubmitting ? (
							<Loader2 className="mx-auto size-4 animate-spin" />
						) : (
							"Add"
						)}
					</button>
					<button
						type="button"
						onClick={() => {
							setIsCreating(false);
							resetForm();
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
