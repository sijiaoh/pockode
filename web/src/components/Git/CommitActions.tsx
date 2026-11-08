import { useQueryClient } from "@tanstack/react-query";
import { GitBranchPlus, PencilLine, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import { gitBranchesQueryKey } from "../../hooks/gitQueries";
import { useGitBranchActions } from "../../hooks/useGitBranches";
import { useGitStatus } from "../../hooks/useGitStatus";
import { usePrefillComposer } from "../../hooks/usePrefillComposer";
import { describeRevertPrompt, isHeadCommit } from "../../lib/commitHistory";
import { branchSwitchPausedReason, headBranchOf } from "../../lib/gitOperation";
import type { GitBranches, GitCommit } from "../../types/git";
import CopyMenuRow from "../common/CopyMenuRow";
import MenuRow from "../common/MenuRow";
import { Sheet } from "../ui";
import ErrorBanner from "./ErrorBanner";
import GitCommitSheet from "./GitCommitSheet";
import NewBranchSheet from "./NewBranchSheet";

/** The commit a `⋯` was pressed for. */
export interface CommitMenuTarget {
	commit: Pick<GitCommit, "hash" | "subject" | "parents" | "refs">;
	/**
	 * Whether HEAD reaches it; absent where that is not known — a filtered
	 * list, a commit's page reached by a link.
	 */
	inHeadHistory?: boolean;
}

interface Props {
	/** The commit whose menu is up; null while none is. */
	target: CommitMenuTarget | null;
	/** The menu, or the sheet it led to, is done with. */
	onClose: () => void;
}

/**
 * A commit's `⋯` menu and what its rows open: amend, a branch at the commit,
 * a revert handed to the agent (docs/git-history-ui.md#the-commit-menu).
 *
 * Mounted by the surface the `⋯` sits on — the History list, the commit's page
 * — for as long as that surface is, rather than with the menu: the handoff's
 * pending state and its failure outlive the press that closes the menu
 * (`usePrefillComposer`'s contract), so the failure banner is drawn where this
 * is placed.
 */
function CommitActions({ target, onClose }: Props) {
	const queryClient = useQueryClient();
	const handoff = usePrefillComposer();
	const { createMutation } = useGitBranchActions();
	const status = useGitStatus().data;
	const operation = status?.operation;
	const [opened, setOpened] = useState<"menu" | "amend" | "branch">("menu");

	const close = () => {
		setOpened("menu");
		onClose();
	};

	// What is up when a handoff settles, which may be long after its press.
	const showing = useRef({ opened, hash: target?.commit.hash });
	showing.current = { opened, hash: target?.commit.hash };

	const revert = async (commit: CommitMenuTarget["commit"]) => {
		// The branch HEAD is on at the press, not the one the menu rendered with.
		const head =
			queryClient.getQueryData<GitBranches>(gitBranchesQueryKey)?.head;
		await handoff.prefill(
			describeRevertPrompt(
				commit,
				head === undefined ? undefined : headBranchOf(head),
			),
		);
		// Only the menu it was pressed in: a sheet opened from it while a session
		// was being created, or another commit's menu, is the user's to close.
		const now = showing.current;
		if (now.opened === "menu" && now.hash === commit.hash) close();
	};

	const commit = target?.commit;
	const short = commit?.hash.substring(0, 7);

	return (
		<>
			{handoff.error && (
				<ErrorBanner
					summary={handoff.error.summary}
					details={handoff.error.detail}
					onDismiss={handoff.dismissError}
				/>
			)}

			{commit && opened === "menu" && (
				<Sheet
					title={`${short} ${commit.subject}`}
					subtitle={<span className="font-mono break-all">{commit.hash}</span>}
					onClose={close}
					dismissible={!handoff.isPending}
				>
					<div className="py-1">
						<CopyMenuRow
							text={commit.hash}
							label="Copy hash"
							onCopied={close}
						/>
						{/* Absent rather than disabled on any commit but HEAD, and on
						    HEAD mid-operation: git refuses amend mid-merge, mid-rebase
						    HEAD is not the branch's commit, and the banner's pause
						    sentence says why commits stopped (docs/git-conflict-ui.md).
						    Absent too until the status says there is no operation. */}
						{isHeadCommit(commit) && status && !operation && (
							<MenuRow
								icon={PencilLine}
								label="Amend this commit"
								onClick={() => setOpened("amend")}
							/>
						)}
						{/* Kept during an operation: the sheet is where the pause is said. */}
						<MenuRow
							icon={GitBranchPlus}
							label="Create branch here…"
							onClick={() => setOpened("branch")}
						/>
						{/* Reverting on this branch what it never had is not an
						    operation; where that is unknown the prompt asks the agent
						    to check instead. */}
						{target.inHeadHistory !== false && (
							<MenuRow
								icon={Sparkles}
								label="Ask AI to revert"
								busy={handoff.isPending}
								onClick={() => void revert(commit)}
							/>
						)}
					</div>
				</Sheet>
			)}

			{commit && opened === "amend" && (
				<GitCommitSheet amendInitially={true} onClose={close} />
			)}

			{commit && opened === "branch" && (
				<NewBranchSheet
					base={`${short} · ${commit.subject}`}
					paused={operation ? branchSwitchPausedReason(operation.kind) : null}
					note="Switches to the new branch at this commit. Uncommitted changes come with you unless they clash with it — then git refuses and nothing changes."
					onClose={close}
					onCreate={async (name) => {
						await createMutation.mutateAsync({ name, start: commit.hash });
						close();
					}}
				/>
			)}
		</>
	);
}

export default CommitActions;
