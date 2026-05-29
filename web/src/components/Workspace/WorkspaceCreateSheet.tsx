import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
	onClose: () => void;
	onCreate: (name: string, path: string) => Promise<void>;
	isCreating: boolean;
	isDesktop: boolean;
	initialData?: { name: string; path: string };
	mode?: "create" | "edit";
}

function WorkspaceCreateSheet({
	onClose,
	onCreate,
	isCreating,
	isDesktop,
	initialData,
	mode = "create",
}: Props) {
	const [name, setName] = useState(initialData?.name ?? "");
	const [path, setPath] = useState(initialData?.path ?? "");
	const [error, setError] = useState<string | null>(null);
	const nameInputRef = useRef<HTMLInputElement>(null);
	const titleId = useId();
	const mobile = !isDesktop;

	useEffect(() => {
		nameInputRef.current?.focus();
	}, []);

	useEffect(() => {
		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};

		document.addEventListener("keydown", handleEscape);
		return () => document.removeEventListener("keydown", handleEscape);
	}, [onClose]);

	useEffect(() => {
		const originalOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";

		return () => {
			document.body.style.overflow = originalOverflow;
		};
	}, []);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);

		const trimmedName = name.trim();
		const trimmedPath = path.trim();

		if (!trimmedName) {
			setError("Name is required");
			return;
		}

		if (!trimmedPath) {
			setError("Path is required");
			return;
		}

		try {
			await onCreate(trimmedName, trimmedPath);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save workspace");
		}
	};

	const canSubmit =
		name.trim().length > 0 && path.trim().length > 0 && !isCreating;
	const isEdit = mode === "edit";

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-end justify-center bg-th-bg-overlay md:items-center"
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
		>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: Overlay backdrop */}
			<div className="absolute inset-0" onClick={onClose} />

			<div
				className={`relative flex w-full flex-col bg-th-bg-secondary shadow-xl ${
					mobile ? "max-h-[90dvh] rounded-t-2xl" : "mx-4 max-w-md rounded-xl"
				}`}
			>
				{mobile && (
					<div className="flex shrink-0 justify-center pt-3">
						<div className="h-1 w-10 rounded-full bg-th-text-muted/30" />
					</div>
				)}

				<div className="flex shrink-0 items-center justify-between border-b border-th-border px-4 py-3">
					<h2 id={titleId} className="text-base font-bold text-th-text-primary">
						{isEdit ? "Edit Workspace" : "New Workspace"}
					</h2>
					<button
						type="button"
						onClick={onClose}
						className="-mr-1 rounded p-1 text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-primary"
						aria-label="Close"
					>
						<X className="h-5 w-5" />
					</button>
				</div>

				<form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
					<div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
						<div className="space-y-1.5">
							<label
								htmlFor="workspace-name"
								className="text-sm text-th-text-primary"
							>
								Name
							</label>
							<input
								ref={nameInputRef}
								id="workspace-name"
								type="text"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="My Project"
								className="w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2.5 text-th-text-primary placeholder:text-th-text-muted focus:border-th-border-focus focus:outline-none focus:ring-2 focus:ring-th-accent/20"
								disabled={isCreating}
								autoComplete="off"
								required
							/>
							<p className="text-xs text-th-text-muted">
								Display name for this workspace
							</p>
						</div>

						<div className="space-y-1.5">
							<label
								htmlFor="workspace-path"
								className="text-sm text-th-text-primary"
							>
								Path
							</label>
							<input
								id="workspace-path"
								type="text"
								value={path}
								onChange={(e) => setPath(e.target.value)}
								placeholder="/home/user/projects/my-project"
								className="w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2.5 text-th-text-primary placeholder:text-th-text-muted focus:border-th-border-focus focus:outline-none focus:ring-2 focus:ring-th-accent/20"
								disabled={isCreating || isEdit}
								autoComplete="off"
								required
							/>
							<p className="text-xs text-th-text-muted">
								Absolute path to the project directory
							</p>
						</div>

						{error && (
							<p className="text-sm text-th-error" role="alert">
								{error}
							</p>
						)}
					</div>

					<div className="flex shrink-0 gap-3 border-t border-th-border p-4">
						<button
							type="button"
							onClick={onClose}
							className="flex-1 rounded-lg bg-th-bg-tertiary px-4 py-2.5 text-sm text-th-text-primary transition-opacity hover:opacity-90"
							disabled={isCreating}
						>
							Cancel
						</button>
						<button
							type="submit"
							className="flex-1 rounded-lg bg-th-accent px-4 py-2.5 text-sm text-th-accent-text transition-colors hover:bg-th-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
							disabled={!canSubmit}
						>
							{isCreating
								? isEdit
									? "Saving..."
									: "Creating..."
								: isEdit
									? "Save"
									: "Create"}
						</button>
					</div>
				</form>
			</div>
		</div>,
		document.body,
	);
}

export default WorkspaceCreateSheet;
