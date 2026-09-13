import { useNavigate } from "@tanstack/react-router";
import { FileCode, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { overlayToNavigation, SETUP_HOOK_PATH } from "../../../lib/navigation";
import { useSettingsStore } from "../../../lib/settingsStore";
import { useWorktreeStore } from "../../../lib/worktreeStore";
import { useWSStore } from "../../../lib/wsStore";

export default function WorktreeSection() {
	const navigate = useNavigate();

	const baseDir = useSettingsStore((s) => s.settings?.worktree_base_dir ?? "");
	const setupHookSkip = useWorktreeStore((s) => s.setupHookSkip);
	const updateSettings = useWSStore((s) => s.actions.updateSettings);

	const [value, setValue] = useState(baseDir);
	const [error, setError] = useState<string | null>(null);
	const [isSaving, setIsSaving] = useState(false);

	// Keep the input in sync when the persisted value changes elsewhere
	// (e.g. a settings.changed notification from another client).
	useEffect(() => {
		setValue(baseDir);
	}, [baseDir]);

	const isDirty = value.trim() !== baseDir;

	const handleSave = useCallback(async () => {
		const trimmed = value.trim();
		if (trimmed === baseDir) return;
		setError(null);
		setIsSaving(true);
		try {
			await updateSettings({ worktree_base_dir: trimmed });
		} catch (err) {
			// Backend returns InvalidParams for a non-absolute or non-clean path;
			// surface the message so the user can correct their input.
			setError(
				err instanceof Error ? err.message : "Failed to update worktree path",
			);
		} finally {
			setIsSaving(false);
		}
	}, [value, baseDir, updateSettings]);

	const handleReset = useCallback(() => {
		setValue(baseDir);
		setError(null);
	}, [baseDir]);

	const handleEditSetupHook = useCallback(() => {
		navigate(
			overlayToNavigation(
				{ type: "file", path: SETUP_HOOK_PATH, edit: true },
				"",
				null,
			),
		);
	}, [navigate]);

	return (
		<div className="space-y-4">
			<div className="space-y-1.5">
				<label
					htmlFor="worktree-base-dir"
					className="text-xs font-medium text-th-text-muted"
				>
					Base Path
				</label>
				<div className="flex items-center gap-2">
					<input
						id="worktree-base-dir"
						type="text"
						value={value}
						onChange={(e) => {
							setValue(e.target.value);
							setError(null);
						}}
						placeholder="../<repo>-worktrees"
						autoComplete="off"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						className="min-w-0 flex-1 rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none"
					/>
					{isDirty && (
						<>
							<button
								type="button"
								onClick={handleSave}
								disabled={isSaving}
								aria-label="Save"
								className="min-h-11 shrink-0 rounded-lg bg-th-accent px-4 text-sm font-medium text-th-accent-text disabled:opacity-50"
							>
								{isSaving ? (
									<Loader2 className="size-4 animate-spin" aria-hidden="true" />
								) : (
									"Save"
								)}
							</button>
							<button
								type="button"
								onClick={handleReset}
								disabled={isSaving}
								className="min-h-11 shrink-0 rounded-lg px-3 text-sm text-th-text-muted hover:bg-th-bg-tertiary disabled:opacity-50"
							>
								Reset
							</button>
						</>
					)}
				</div>
				{error ? (
					<p className="text-xs text-th-error" role="alert">
						{error}
					</p>
				) : (
					<p className="text-xs text-th-text-muted">
						Where new worktrees are created. Use an absolute path, or{" "}
						<code className="text-th-text-secondary">./</code> /{" "}
						<code className="text-th-text-secondary">../</code> (relative to the
						repository) / <code className="text-th-text-secondary">~/</code>{" "}
						(home directory). Leave empty to use the default (
						<code className="text-th-text-secondary">
							../&lt;repo&gt;-worktrees
						</code>
						).
					</p>
				)}
			</div>

			<div className="space-y-1.5">
				<button
					type="button"
					onClick={handleEditSetupHook}
					className="flex min-h-14 w-full items-center gap-3 rounded-lg border border-th-border bg-th-bg-secondary px-4 text-left text-sm text-th-text-primary transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent hover:border-th-accent active:scale-[0.99]"
				>
					<FileCode className="h-5 w-5 text-th-text-muted" />
					<div className="flex flex-col gap-0.5">
						<span>Setup Hook</span>
						<span className="text-xs text-th-text-muted">
							Script to run when creating new worktrees
						</span>
					</div>
				</button>
				{/* The script is silently skipped when the server has no shell to run
				    it with, so say so where the script itself is managed. */}
				{setupHookSkip && (
					<div className="space-y-1 rounded-lg border border-th-warning/40 bg-th-warning/5 px-3 py-2">
						<p className="text-xs text-th-warning">
							This script does not run on the server.
						</p>
						<p className="text-xs text-th-text-secondary">
							{setupHookSkip.reason}
						</p>
						<p className="text-xs text-th-text-muted">{setupHookSkip.hint}</p>
					</div>
				)}
			</div>
		</div>
	);
}
