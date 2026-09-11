import { useNavigate } from "@tanstack/react-router";
import { Type } from "lucide-react";
import { useMemo, useState } from "react";
import { useCommitFile } from "../../hooks/useCommitFile";
import { useGitCommit } from "../../hooks/useGitCommit";
import { useRouteState } from "../../hooks/useRouteState";
import { overlayToNavigation } from "../../lib/navigation";
import { getFileViewState } from "../../utils/fileView";
import FileBody from "../Files/FileBody";
import { BottomActionBar, ContentView, ToggleIconButton } from "../ui";

interface Props {
	hash: string;
	path: string;
}

/**
 * A file as one commit left it.
 *
 * Read-only throughout: history cannot be edited, so the bottom bar carries no
 * write action at all rather than a disabled one, which would read as a bug or
 * a permission problem. No download either — `/api/files/download` only serves
 * the working tree.
 */
function CommitFileView({ hash, path }: Props) {
	const navigate = useNavigate();
	const { worktree, sessionId } = useRouteState();
	// Kept across files: someone reading several historical files in a row
	// should not have to press it again for each.
	const [plain, setPlain] = useState(false);
	const { data: commit } = useGitCommit(hash);
	const { data: file, isLoading, error } = useCommitFile(hash, path);

	const state = useMemo(() => (file ? getFileViewState(file) : null), [file]);

	const handleBack = () => {
		navigate(
			overlayToNavigation(
				{ type: "commit-diff", hash, path },
				worktree,
				sessionId,
			),
		);
	};

	const shortHash = hash.substring(0, 7);

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<ContentView
				path={path}
				pathColor="text-th-accent"
				isLoading={isLoading}
				error={error instanceof Error ? error : null}
				onBack={handleBack}
			>
				{/* One banner for both facts: which version this is and that it
				    cannot be changed. Two would read as two separate problems. */}
				<div className="flex gap-1 border-b border-th-border bg-th-bg-secondary px-4 py-2 text-xs text-th-text-muted">
					<span className="shrink-0">
						Read-only — this file as of <code>{shortHash}</code>
					</span>
					{commit && <span className="truncate">· {commit.subject}</span>}
				</div>
				{state && <FileBody state={state} path={path} plain={plain} readOnly />}
			</ContentView>
			<BottomActionBar>
				<div className="flex items-center gap-2">
					{/* Absent rather than present and inert wherever it could not
					    change anything: an image or a binary has no rendering to drop
					    to source, and a file past `HIGHLIGHT_LIMIT` is already plain
					    with a banner that says so. The bar itself stays either way —
					    the hash is identity, not an action. */}
					{state?.kind === "text" && state.highlight && (
						<ToggleIconButton
							icon={Type}
							pressed={plain}
							onClick={() => setPlain((v) => !v)}
							label={plain ? "Show rendered" : "Show plain text"}
						/>
					)}
					<div className="ml-auto text-xs text-th-text-muted">{shortHash}</div>
				</div>
			</BottomActionBar>
		</div>
	);
}

export default CommitFileView;
