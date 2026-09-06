import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { overlayToNavigation, SETUP_HOOK_PATH } from "../../lib/navigation";
import { Sheet } from "../ui";

interface Props {
	onClose: () => void;
	onCreate: (
		name: string,
		branch: string,
		baseBranch?: string,
	) => Promise<void>;
	isCreating: boolean;
}

function WorktreeCreateSheet({ onClose, onCreate, isCreating }: Props) {
	const navigate = useNavigate();
	const [name, setName] = useState("");
	const [branch, setBranch] = useState("");
	const [baseBranch, setBaseBranch] = useState("");
	const [error, setError] = useState<string | null>(null);
	const nameInputRef = useRef<HTMLInputElement>(null);

	// Focus name input on mount
	useEffect(() => {
		nameInputRef.current?.focus();
	}, []);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);

		const trimmedName = name.trim();
		if (!trimmedName) {
			setError("Name is required");
			return;
		}

		// Default branch to name if not specified
		const trimmedBranch = branch.trim() || trimmedName;
		const trimmedBaseBranch = baseBranch.trim() || undefined;

		try {
			await onCreate(trimmedName, trimmedBranch, trimmedBaseBranch);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to create worktree",
			);
		}
	};

	const canSubmit = name.trim().length > 0 && !isCreating;

	return (
		<Sheet
			title="New Worktree"
			onClose={onClose}
			// Cancel is already disabled while creating; the backdrop and Escape
			// have to agree with it, or the sheet vanishes mid-create.
			dismissible={!isCreating}
			onSubmit={handleSubmit}
			footer={
				<>
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
						{isCreating ? "Creating..." : "Create"}
					</button>
				</>
			}
		>
			<div className="space-y-4 p-4">
				{/* Name input */}
				<div className="space-y-1.5">
					<label
						htmlFor="worktree-name"
						className="text-sm text-th-text-primary"
					>
						Name
					</label>
					<input
						ref={nameInputRef}
						id="worktree-name"
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="review"
						className="w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2.5 text-th-text-primary placeholder:text-th-text-muted focus:border-th-border-focus focus:outline-none focus:ring-2 focus:ring-th-accent/20"
						disabled={isCreating}
						autoComplete="off"
						required
					/>
					<p className="text-xs text-th-text-muted">Worktree directory name</p>
				</div>

				{/* Branch input */}
				<div className="space-y-1.5">
					<label
						htmlFor="worktree-branch"
						className="text-sm text-th-text-primary"
					>
						Branch{" "}
						<span className="font-normal text-th-text-muted">(optional)</span>
					</label>
					<input
						id="worktree-branch"
						type="text"
						value={branch}
						onChange={(e) => setBranch(e.target.value)}
						placeholder="feature/my-feature"
						className="w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2.5 text-th-text-primary placeholder:text-th-text-muted focus:border-th-border-focus focus:outline-none focus:ring-2 focus:ring-th-accent/20"
						disabled={isCreating}
						autoComplete="off"
					/>
					<p className="text-xs text-th-text-muted">Uses name if empty</p>
				</div>

				{/* Base Branch input */}
				<div className="space-y-1.5">
					<label
						htmlFor="worktree-base-branch"
						className="text-sm text-th-text-primary"
					>
						Base Branch{" "}
						<span className="font-normal text-th-text-muted">(optional)</span>
					</label>
					<input
						id="worktree-base-branch"
						type="text"
						value={baseBranch}
						onChange={(e) => setBaseBranch(e.target.value)}
						placeholder="main"
						className="w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2.5 text-th-text-primary placeholder:text-th-text-muted focus:border-th-border-focus focus:outline-none focus:ring-2 focus:ring-th-accent/20"
						disabled={isCreating}
						autoComplete="off"
					/>
					<p className="text-xs text-th-text-muted">
						Base for new branch (ignored if branch exists)
					</p>
				</div>

				{/* Info */}
				<p className="rounded-lg bg-th-bg-tertiary px-3 py-2 text-sm text-th-text-secondary">
					Setup script runs after creation.{" "}
					<button
						type="button"
						className="text-th-accent hover:underline"
						onClick={() => {
							onClose();
							navigate(
								overlayToNavigation(
									{ type: "file", path: SETUP_HOOK_PATH, edit: true },
									"",
									null,
								),
							);
						}}
					>
						Customize
					</button>
				</p>

				{/* Error message */}
				{error && (
					<p className="text-sm text-th-error" role="alert">
						{error}
					</p>
				)}
			</div>
		</Sheet>
	);
}

export default WorktreeCreateSheet;
