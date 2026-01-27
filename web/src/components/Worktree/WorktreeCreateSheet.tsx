import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
	onClose: () => void;
	onCreate: (
		name: string,
		branch: string,
		baseBranch?: string,
	) => Promise<void>;
	isCreating: boolean;
	/** Whether in desktop mode (controls layout) */
	isDesktop: boolean;
}

function WorktreeCreateSheet({
	onClose,
	onCreate,
	isCreating,
	isDesktop,
}: Props) {
	const [name, setName] = useState("");
	const [branch, setBranch] = useState("");
	const [baseBranch, setBaseBranch] = useState("");
	const [error, setError] = useState<string | null>(null);
	const nameInputRef = useRef<HTMLInputElement>(null);
	const titleId = useId();
	const mobile = !isDesktop;

	// Focus name input on mount
	useEffect(() => {
		nameInputRef.current?.focus();
	}, []);

	// Close on Escape
	useEffect(() => {
		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};

		document.addEventListener("keydown", handleEscape);
		return () => document.removeEventListener("keydown", handleEscape);
	}, [onClose]);

	// Prevent body scroll
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

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-end justify-center bg-th-bg-overlay sm:items-center"
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
		>
			{/* Backdrop */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: Overlay backdrop - Escape key handled in useEffect */}
			<div className="absolute inset-0" onClick={onClose} />

			{/* Content */}
			<div
				className={`relative w-full bg-th-bg-secondary shadow-xl ${
					mobile ? "max-h-[90dvh] rounded-t-2xl" : "mx-4 max-w-md rounded-xl"
				}`}
			>
				{/* Drag handle - mobile only */}
				{mobile && (
					<div className="flex shrink-0 justify-center pt-3">
						<div className="h-1 w-10 rounded-full bg-th-text-muted/30" />
					</div>
				)}

				{/* Header */}
				<div className="flex items-center justify-between border-b border-th-border px-4 py-3">
					<h2 id={titleId} className="text-base font-bold text-th-text-primary">
						New Worktree
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

				{/* Form */}
				<form onSubmit={handleSubmit}>
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
							<p className="text-xs text-th-text-muted">
								Worktree directory name
							</p>
						</div>

						{/* Branch input */}
						<div className="space-y-1.5">
							<label
								htmlFor="worktree-branch"
								className="text-sm text-th-text-primary"
							>
								Branch{" "}
								<span className="font-normal text-th-text-muted">
									(optional)
								</span>
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
								<span className="font-normal text-th-text-muted">
									(optional)
								</span>
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

						{/* Error message */}
						{error && (
							<p className="text-sm text-th-error" role="alert">
								{error}
							</p>
						)}
					</div>

					{/* Footer */}
					<div className="flex gap-3 border-t border-th-border p-4">
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
					</div>
				</form>
			</div>
		</div>,
		document.body,
	);
}

export default WorktreeCreateSheet;
