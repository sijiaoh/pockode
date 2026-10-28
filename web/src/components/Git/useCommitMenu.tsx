import { useCallback, useState } from "react";
import type { HistoryRow } from "../../hooks/useHistoryGraph";
import CommitActions, { type CommitMenuTarget } from "./CommitActions";

/**
 * The `⋯` of a list of commits — History's, a branch's — and the menu it
 * opens, mounted for as long as the list is (`CommitActions`'s contract).
 * The caller renders `menu` where the handoff's failure belongs.
 */
export function useCommitMenu(rows: HistoryRow[]): {
	openMenu: (row: HistoryRow) => void;
	menu: React.ReactNode;
} {
	const [menuFor, setMenuFor] = useState<CommitMenuTarget | null>(null);
	// Stable, so a menu opened does not re-render every memoized row.
	const openMenu = useCallback(
		({ commit, inHeadHistory }: HistoryRow) =>
			setMenuFor({ commit, inHeadHistory }),
		[],
	);
	const closeMenu = useCallback(() => setMenuFor(null), []);
	// From the list as it is now rather than as it was at the press: a commit
	// made meanwhile moves HEAD, and amend is HEAD's. A commit no longer listed
	// has been rewritten or left the range; its refs are no longer known, and
	// HEAD — which an amend would rewrite — is not among them.
	const menuRow =
		menuFor && rows.find((r) => r.commit.hash === menuFor.commit.hash);
	const target: CommitMenuTarget | null = menuRow
		? { commit: menuRow.commit, inHeadHistory: menuRow.inHeadHistory }
		: menuFor && { commit: { ...menuFor.commit, refs: [] } };

	return {
		openMenu,
		menu: <CommitActions target={target} onClose={closeMenu} />,
	};
}
