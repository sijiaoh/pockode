import { useMemo, useRef } from "react";
import type { GraphRow, GraphState } from "../lib/commitGraph";
import {
	createHistoryGraphState,
	headHistoryFlags,
	layoutHistoryPage,
} from "../lib/commitHistory";
import type { GitCommit, GitHistoryScope, GitLogResult } from "../types/git";

export interface HistoryRow {
	commit: GitCommit;
	/** Absent where no graph is drawn: a search or a file filter is on. */
	graph?: GraphRow;
	/**
	 * Whether HEAD reaches the commit; absent where that is not known — no
	 * graph, so no connected history to tell it by.
	 */
	inHeadHistory?: boolean;
}

interface PageLayout {
	from: GraphState;
	rows: GraphRow[];
	to: GraphState;
}

/**
 * The loaded pages as rows, with the graph laid out — and which rows HEAD
 * reaches — when `drawGraph`.
 *
 * Each page continues from the state the one before it left, and a page whose
 * starting state is the one it was laid out from last time keeps its rows: a
 * page appended at the bottom costs only its own layout. A re-read hands back
 * new page objects, which lay out afresh.
 */
export function useHistoryGraph(
	pages: readonly GitLogResult[] | undefined,
	scope: GitHistoryScope,
	drawGraph: boolean,
): HistoryRow[] {
	// By value: a re-read hands back a new array of the same names.
	const lineKey = (pages?.[0]?.default_line ?? []).join("\n");
	const defaultLine = useMemo(
		() => (lineKey ? lineKey.split("\n") : undefined),
		[lineKey],
	);
	const initial = useMemo(
		() => createHistoryGraphState({ scope, defaultLine }),
		[scope, defaultLine],
	);
	const cache = useRef(new WeakMap<GitLogResult, PageLayout>());

	return useMemo(() => {
		if (!pages) return [];
		if (!drawGraph) {
			return pages.flatMap((page) =>
				page.commits.map((commit) => ({ commit })),
			);
		}
		// Not cached by page like the lanes: one pass over hashes is cheap next
		// to a layout.
		const inHead = headHistoryFlags(pages.flatMap((page) => page.commits));
		const rows: HistoryRow[] = [];
		let state = initial;
		for (const page of pages) {
			let laid = cache.current.get(page);
			if (laid?.from !== state) {
				const next = layoutHistoryPage(page.commits, state, defaultLine);
				laid = { from: state, rows: next.rows, to: next.state };
				cache.current.set(page, laid);
			}
			const graph = laid.rows;
			page.commits.forEach((commit, i) => {
				rows.push({
					commit,
					graph: graph[i],
					inHeadHistory: inHead[rows.length],
				});
			});
			state = laid.to;
		}
		return rows;
	}, [pages, drawGraph, initial, defaultLine]);
}
