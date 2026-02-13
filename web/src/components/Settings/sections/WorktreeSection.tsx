import { useNavigate } from "@tanstack/react-router";
import { FileCode } from "lucide-react";
import { useCallback } from "react";
import { overlayToNavigation, SETUP_HOOK_PATH } from "../../../lib/navigation";

export default function WorktreeSection() {
	const navigate = useNavigate();

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
	);
}
