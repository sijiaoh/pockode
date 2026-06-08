import { useEffect, useRef, useState } from "react";
import { useIsDesktop } from "../hooks";
import type { Node } from "../types/node";
import { ResponsivePanel, Spinner } from "./ui";

interface Props {
	isOpen: boolean;
	onClose: () => void;
	onSubmit: (path: string, name?: string) => Promise<void>;
	editingNode?: Node | null;
}

export function NodeForm({ isOpen, onClose, onSubmit, editingNode }: Props) {
	const [path, setPath] = useState("");
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const pathInputRef = useRef<HTMLInputElement>(null);
	const isDesktop = useIsDesktop();

	const isEditing = !!editingNode;

	useEffect(() => {
		if (isOpen) {
			if (editingNode) {
				setPath(editingNode.path);
				setName(editingNode.name);
			} else {
				setPath("");
				setName("");
			}
			setError(null);
			// Focus path input after panel opens
			setTimeout(() => pathInputRef.current?.focus(), 100);
		}
	}, [isOpen, editingNode]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!path.trim()) {
			setError("Path is required");
			return;
		}

		setSaving(true);
		setError(null);

		try {
			await onSubmit(path.trim(), name.trim() || undefined);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save node");
		} finally {
			setSaving(false);
		}
	};

	// Derive name placeholder from path
	const namePlaceholder = path.trim()
		? path.trim().split("/").filter(Boolean).pop() || ""
		: "Derived from path";

	return (
		<ResponsivePanel
			isOpen={isOpen}
			onClose={onClose}
			title={isEditing ? "Edit Node" : "Add Node"}
			isDesktop={isDesktop}
		>
			<form onSubmit={handleSubmit} className="flex flex-col gap-4">
				{/* Path field */}
				<div>
					<label
						htmlFor="node-path"
						className="mb-1 block text-sm text-th-text-secondary"
					>
						Project Path <span className="text-th-error">*</span>
					</label>
					<input
						ref={pathInputRef}
						id="node-path"
						type="text"
						value={path}
						onChange={(e) => setPath(e.target.value)}
						placeholder="/Users/you/projects/my-app"
						className="min-h-[44px] w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-border-focus focus:outline-none"
						disabled={saving}
					/>
				</div>

				{/* Name field */}
				<div>
					<label
						htmlFor="node-name"
						className="mb-1 block text-sm text-th-text-secondary"
					>
						Display Name
					</label>
					<input
						id="node-name"
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder={namePlaceholder}
						className="min-h-[44px] w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-border-focus focus:outline-none"
						disabled={saving}
					/>
					<p className="mt-1 text-xs text-th-text-muted">
						Leave empty to use the directory name
					</p>
				</div>

				{/* Error message */}
				{error && (
					<p className="text-sm text-th-error" role="alert">
						{error}
					</p>
				)}

				{/* Actions */}
				<div className="flex justify-end gap-3 pt-2">
					<button
						type="button"
						onClick={onClose}
						disabled={saving}
						className="min-h-[44px] rounded-lg border border-th-border px-4 py-2 text-sm font-medium text-th-text-primary hover:bg-th-overlay-hover disabled:opacity-50"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={saving || !path.trim()}
						className="flex min-h-[44px] items-center gap-2 rounded-lg bg-th-accent px-4 py-2 text-sm font-medium text-th-accent-text hover:bg-th-accent-hover disabled:opacity-50"
					>
						{saving && <Spinner />}
						{isEditing ? "Save" : "Add Node"}
					</button>
				</div>
			</form>
		</ResponsivePanel>
	);
}
