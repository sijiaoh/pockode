import {
	AlertCircle,
	Check,
	ChevronDown,
	ChevronUp,
	GripVertical,
	Loader2,
	Pencil,
	Plus,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { useInlineEdit } from "../../hooks/useInlineEdit";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { useWSStore } from "../../lib/wsStore";
import type { AgentRole } from "../../types/agentRole";
import { MarkdownContent } from "../Chat/MarkdownContent";
import ConfirmDialog from "../common/ConfirmDialog";
import BackButton from "../ui/BackButton";

interface Props {
	roleId: string;
	onBack: () => void;
}

export default function AgentRoleDetailOverlay({ roleId, onBack }: Props) {
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
					<StepsEditor role={role} />
					<DeleteSection role={role} onDeleted={onBack} />
				</div>
			</div>
		</div>
	);
}

function DetailHeader({ onBack }: { onBack: () => void }) {
	return (
		<header className="flex items-center gap-1.5 border-b border-th-border bg-th-bg-secondary px-2 py-2">
			<BackButton onClick={onBack} aria-label="Back to agent roles" />
			<h1 className="flex-1 px-2 text-sm font-bold text-th-text-primary">
				Agent Role
			</h1>
		</header>
	);
}

function InlineEditableName({ role }: { role: AgentRole }) {
	const updateAgentRole = useWSStore((s) => s.actions.updateAgentRole);
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
		initialValue: role.name,
		onSave: useCallback(
			(trimmed: string) => updateAgentRole({ id: role.id, name: trimmed }),
			[updateAgentRole, role.id],
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
				{role.name}
			</h2>
			<button
				type="button"
				onClick={() => setEditing(true)}
				className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg text-th-text-muted opacity-60 transition-opacity hover:bg-th-bg-tertiary hover:text-th-text-primary md:opacity-0 md:group-hover:opacity-100"
				aria-label="Edit name"
			>
				<Pencil className="size-4" />
			</button>
		</div>
	);
}

function InlineEditableRolePrompt({ role }: { role: AgentRole }) {
	const updateAgentRole = useWSStore((s) => s.actions.updateAgentRole);
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
		initialValue: role.role_prompt,
		onSave: useCallback(
			(trimmed: string) =>
				updateAgentRole({ id: role.id, role_prompt: trimmed }),
			[updateAgentRole, role.id],
		),
		allowEmpty: true,
	});

	if (editing) {
		return (
			<div>
				<h3 className="mb-1 text-xs font-medium text-th-text-muted uppercase">
					Role Prompt
				</h3>
				<TextareaAutosize
					ref={ref}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape") cancel();
					}}
					disabled={saving}
					placeholder="Enter role prompt..."
					minRows={6}
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

	if (!role.role_prompt) {
		return (
			<div>
				<h3 className="mb-1 text-xs font-medium text-th-text-muted uppercase">
					Role Prompt
				</h3>
				<button
					type="button"
					onClick={() => setEditing(true)}
					className="min-h-[44px] w-full rounded-lg border border-dashed border-th-border px-3 text-left text-sm text-th-text-muted hover:border-th-text-muted hover:text-th-text-secondary"
				>
					Add role prompt...
				</button>
			</div>
		);
	}

	return (
		<div>
			<div className="group flex items-center justify-between mb-1">
				<h3 className="text-xs font-medium text-th-text-muted uppercase">
					Role Prompt
				</h3>
				<button
					type="button"
					onClick={() => setEditing(true)}
					className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-th-text-muted opacity-60 transition-opacity hover:bg-th-bg-tertiary hover:text-th-text-primary md:opacity-0 md:group-hover:opacity-100"
					aria-label="Edit role prompt"
				>
					<Pencil className="size-3.5" />
				</button>
			</div>
			<div className="rounded-lg bg-th-bg-secondary px-3 py-2">
				<MarkdownContent content={role.role_prompt} />
			</div>
		</div>
	);
}

interface StepItem {
	id: string;
	value: string;
}

let stepIdCounter = 0;

function createStepItems(steps: string[]): StepItem[] {
	return steps.map((value) => ({
		id: `step-${++stepIdCounter}`,
		value,
	}));
}

function StepsEditor({ role }: { role: AgentRole }) {
	const updateAgentRole = useWSStore((s) => s.actions.updateAgentRole);
	const [editing, setEditing] = useState(false);
	const [stepItems, setStepItems] = useState<StepItem[]>(() =>
		createStepItems(role.steps ?? []),
	);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dragId, setDragId] = useState<string | null>(null);
	const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);

	// Sync local state when role changes externally
	useEffect(() => {
		if (!editing) {
			setStepItems(createStepItems(role.steps ?? []));
		}
	}, [role.steps, editing]);

	const handleSave = useCallback(async () => {
		const filtered = stepItems
			.map((s) => s.value.trim())
			.filter((s) => s !== "");
		setError(null);
		setSaving(true);
		try {
			await updateAgentRole({ id: role.id, steps: filtered });
			setStepItems(createStepItems(filtered));
			setEditing(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save");
		} finally {
			setSaving(false);
		}
	}, [stepItems, updateAgentRole, role.id]);

	const handleCancel = useCallback(() => {
		setStepItems(createStepItems(role.steps ?? []));
		setEditing(false);
		setError(null);
	}, [role.steps]);

	const addStep = useCallback(() => {
		setStepItems((prev) => [
			...prev,
			{ id: `step-${++stepIdCounter}`, value: "" },
		]);
	}, []);

	const updateStep = useCallback((id: string, value: string) => {
		setStepItems((prev) =>
			prev.map((s) => (s.id === id ? { ...s, value } : s)),
		);
	}, []);

	const removeStep = useCallback((id: string) => {
		setStepItems((prev) => prev.filter((s) => s.id !== id));
	}, []);

	const moveStep = useCallback((fromId: string, toIndex: number) => {
		setStepItems((prev) => {
			const fromIndex = prev.findIndex((s) => s.id === fromId);
			if (fromIndex === -1 || fromIndex === toIndex) return prev;
			const next = [...prev];
			const [item] = next.splice(fromIndex, 1);
			next.splice(toIndex, 0, item);
			return next;
		});
	}, []);

	const moveStepUp = useCallback((id: string) => {
		setStepItems((prev) => {
			const index = prev.findIndex((s) => s.id === id);
			if (index <= 0) return prev;
			const next = [...prev];
			[next[index - 1], next[index]] = [next[index], next[index - 1]];
			return next;
		});
	}, []);

	const moveStepDown = useCallback((id: string) => {
		setStepItems((prev) => {
			const index = prev.findIndex((s) => s.id === id);
			if (index === -1 || index >= prev.length - 1) return prev;
			const next = [...prev];
			[next[index], next[index + 1]] = [next[index + 1], next[index]];
			return next;
		});
	}, []);

	const handleDragStart = useCallback((id: string) => {
		setDragId(id);
	}, []);

	const handleDragOver = useCallback(
		(e: React.DragEvent, targetIndex: number) => {
			e.preventDefault();
			setDropTargetIndex(targetIndex);
		},
		[],
	);

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		// Only clear if leaving the container entirely (not just moving to a child)
		const relatedTarget = e.relatedTarget as Node | null;
		if (!e.currentTarget.contains(relatedTarget)) {
			setDropTargetIndex(null);
		}
	}, []);

	const handleDragEnd = useCallback(() => {
		if (dragId !== null && dropTargetIndex !== null) {
			// Adjust target index: if dragging down, account for the item being removed
			const fromIndex = stepItems.findIndex((s) => s.id === dragId);
			let adjustedIndex = dropTargetIndex;
			if (fromIndex !== -1 && fromIndex < dropTargetIndex) {
				adjustedIndex = dropTargetIndex - 1;
			}
			if (fromIndex !== adjustedIndex) {
				moveStep(dragId, adjustedIndex);
			}
		}
		setDragId(null);
		setDropTargetIndex(null);
	}, [dragId, dropTargetIndex, stepItems, moveStep]);

	if (editing) {
		return (
			<div>
				<h3 className="mb-2 text-xs font-medium uppercase text-th-text-muted">
					Steps
				</h3>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: container for drag-and-drop */}
				<div onDragLeave={handleDragLeave}>
					<ul className="space-y-2">
						{stepItems.map((item, index) => (
							<li key={item.id} className="relative">
								{/* Drop indicator line */}
								{dropTargetIndex === index &&
									dragId !== null &&
									dragId !== item.id && (
										<div className="absolute -top-1 left-0 right-0 z-10 flex items-center">
											<div className="h-0.5 flex-1 rounded-full bg-th-accent" />
											<div className="size-2 rounded-full bg-th-accent" />
											<div className="h-0.5 flex-1 rounded-full bg-th-accent" />
										</div>
									)}
								{/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for drag-and-drop reordering */}
								<div
									onDragOver={(e) => handleDragOver(e, index)}
									className={`flex items-start gap-1 rounded-lg border bg-th-bg-primary p-1 transition-all duration-150 ${
										dragId === item.id
											? "scale-[0.98] border-th-accent opacity-50 shadow-lg"
											: "border-th-border"
									}`}
								>
									{/* Drag handle - only this is draggable */}
									<button
										type="button"
										draggable
										onDragStart={() => handleDragStart(item.id)}
										onDragEnd={handleDragEnd}
										className="mt-1.5 flex min-h-[36px] min-w-[36px] cursor-grab touch-none items-center justify-center text-th-text-muted active:cursor-grabbing"
										aria-label="Drag to reorder"
									>
										<GripVertical className="size-4" />
									</button>
									<div className="flex min-w-0 flex-1 items-center gap-1">
										<span className="shrink-0 text-xs font-medium text-th-text-muted">
											{index + 1}.
										</span>
										<TextareaAutosize
											value={item.value}
											onChange={(e) => updateStep(item.id, e.target.value)}
											disabled={saving}
											placeholder="Enter step..."
											minRows={1}
											className="min-w-0 flex-1 resize-none rounded border-none bg-transparent px-1 py-1 text-sm text-th-text-primary placeholder:text-th-text-muted focus:outline-none"
										/>
									</div>
									{/* Move up/down buttons */}
									<div className="mt-1.5 flex items-center gap-0.5">
										<button
											type="button"
											onClick={() => moveStepUp(item.id)}
											disabled={saving || index === 0}
											className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded text-th-text-muted hover:bg-th-bg-tertiary disabled:opacity-30"
											aria-label="Move up"
										>
											<ChevronUp className="size-3.5" />
										</button>
										<button
											type="button"
											onClick={() => moveStepDown(item.id)}
											disabled={saving || index === stepItems.length - 1}
											className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded text-th-text-muted hover:bg-th-bg-tertiary disabled:opacity-30"
											aria-label="Move down"
										>
											<ChevronDown className="size-3.5" />
										</button>
										<button
											type="button"
											onClick={() => removeStep(item.id)}
											disabled={saving}
											className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-error"
											aria-label="Remove step"
										>
											<Trash2 className="size-3.5" />
										</button>
									</div>
								</div>
							</li>
						))}
					</ul>
					{/* Drop zone for appending at the end */}
					{dragId !== null && (
						// biome-ignore lint/a11y/noStaticElementInteractions: drop zone for drag-and-drop reordering
						<div
							onDragOver={(e) => handleDragOver(e, stepItems.length)}
							className="h-8"
						>
							{dropTargetIndex === stepItems.length && (
								<div className="flex items-center py-3">
									<div className="h-0.5 flex-1 rounded-full bg-th-accent" />
									<div className="size-2 rounded-full bg-th-accent" />
									<div className="h-0.5 flex-1 rounded-full bg-th-accent" />
								</div>
							)}
						</div>
					)}
				</div>
				<button
					type="button"
					onClick={addStep}
					disabled={saving}
					className="mt-2 flex min-h-[44px] items-center gap-2 rounded-lg px-3 text-sm text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-secondary"
				>
					<Plus className="size-4" />
					Add step
				</button>
				<div className="mt-3 flex items-center gap-2">
					<button
						type="button"
						onClick={handleSave}
						disabled={saving}
						className="min-h-[44px] rounded-lg bg-th-accent px-4 text-sm font-medium text-th-accent-text disabled:opacity-50"
					>
						{saving ? "Saving..." : "Save"}
					</button>
					<button
						type="button"
						onClick={handleCancel}
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

	const displaySteps = role.steps ?? [];
	if (displaySteps.length === 0) {
		return (
			<div>
				<h3 className="mb-1 text-xs font-medium uppercase text-th-text-muted">
					Steps
				</h3>
				<button
					type="button"
					onClick={() => setEditing(true)}
					className="min-h-[44px] w-full rounded-lg border border-dashed border-th-border px-3 text-left text-sm text-th-text-muted hover:border-th-text-muted hover:text-th-text-secondary"
				>
					Add steps...
				</button>
			</div>
		);
	}

	return (
		<div>
			<div className="group mb-1 flex items-center justify-between">
				<h3 className="text-xs font-medium uppercase text-th-text-muted">
					Steps
				</h3>
				<button
					type="button"
					onClick={() => setEditing(true)}
					className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-th-text-muted opacity-60 transition-opacity hover:bg-th-bg-tertiary hover:text-th-text-primary md:opacity-0 md:group-hover:opacity-100"
					aria-label="Edit steps"
				>
					<Pencil className="size-3.5" />
				</button>
			</div>
			<ol className="space-y-1 rounded-lg bg-th-bg-secondary px-3 py-2">
				{displaySteps.map((step, index) => (
					<li
						key={`display-${index}-${step.slice(0, 20)}`}
						className="flex items-start gap-2 text-sm text-th-text-primary"
					>
						<span className="shrink-0 font-medium text-th-text-muted">
							{index + 1}.
						</span>
						<MarkdownContent content={step} />
					</li>
				))}
			</ol>
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
		<div className="border-t border-th-border pt-5">
			<button
				type="button"
				onClick={() => setShowConfirm(true)}
				className="flex min-h-[44px] items-center gap-2 rounded-lg px-3 text-sm text-th-error hover:bg-th-error/10"
			>
				<Trash2 className="size-4" />
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
