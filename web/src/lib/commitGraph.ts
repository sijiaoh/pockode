/**
 * Lane layout for the history graph. The server only sends commits and their
 * parents; lanes are laid out here because how many of them fit depends on the
 * screen, and that is only known on the device.
 *
 * Layout and folding are separate on purpose: `layoutCommits` is independent
 * of width, so a page appended later continues the lanes of the pages before it
 * without touching their rows, and a resize only re-runs `foldRow`.
 */

export interface GraphCommit {
	hash: string;
	parents: readonly string[];
	/**
	 * Reserved lanes this commit's line is meant for (see `createGraphState`'s
	 * `reserve`). Only the first commit to claim a lane gets it; a claim on a
	 * lane already taken or released is ignored, so the caller may mark every
	 * commit that could be the one.
	 */
	claims?: readonly number[];
}

/**
 * A segment in one half of a row, between two lanes. `line` identifies the
 * branch line it belongs to, stable across rows, for colouring.
 */
export interface GraphEdge {
	from: number;
	to: number;
	line: number;
}

export interface GraphRow {
	hash: string;
	/** The lane the commit's node sits in. */
	lane: number;
	line: number;
	/** From the row's top edge down to the node's height. */
	above: GraphEdge[];
	/** From the node's height down to the row's bottom edge. */
	below: GraphEdge[];
}

interface Lane {
	/** The commit this lane is heading down to. */
	hash: string;
	line: number;
	/** No node has been drawn on this line yet. */
	fresh: boolean;
}

export interface GraphState {
	readonly lanes: readonly (Lane | null)[];
	/** Reserved lanes no commit has claimed yet, kept empty until one does. */
	readonly pending: readonly number[];
	readonly nextLine: number;
	readonly firstParent: boolean;
}

/**
 * `firstParent` is for a `--first-parent` log: git still lists a merge's
 * other parents, but they will never appear in the result, so following them
 * would hold a lane open per merge all the way to the bottom.
 *
 * `reserve` keeps lanes 0…reserve-1 empty for the lines the caller names by
 * `GraphCommit.claims` — HEAD's line and the default branch's — so that they
 * are the leftmost, and the last a lane cap hides, even where newer commits of
 * other branches come first. A reserved lane's line takes the lane's number as
 * its id, so those lines also get the first colours.
 */
export function createGraphState(
	options: { firstParent?: boolean; reserve?: number } = {},
): GraphState {
	const reserve = options.reserve ?? 0;
	return {
		lanes: [],
		pending: Array.from({ length: reserve }, (_, i) => i),
		nextLine: reserve,
		firstParent: options.firstParent ?? false,
	};
}

function freeLane(lanes: (Lane | null)[], pending: readonly number[]): number {
	for (let i = 0; ; i++) {
		if (!lanes[i] && !pending.includes(i)) return i;
	}
}

/**
 * Lays out the next page of commits, in date order (children before parents),
 * continuing from the state the previous page left. Lanes never shift
 * sideways: a line stays in its lane from top to bottom, and a lane is released
 * when its line merges or ends, to be reused by the next one that needs it.
 */
export function layoutCommits(
	commits: readonly GraphCommit[],
	state: GraphState,
): { rows: GraphRow[]; state: GraphState } {
	const lanes = [...state.lanes];
	let pending = state.pending;
	let nextLine = state.nextLine;
	const rows: GraphRow[] = [];

	for (const commit of commits) {
		const waiting = lanes.flatMap((occupant, i) =>
			occupant?.hash === commit.hash ? [i] : [],
		);
		const claimed = (commit.claims ?? [])
			.filter((c) => pending.includes(c))
			.sort((a, b) => a - b);
		pending = pending.filter((p) => !claimed.includes(p));
		// A lane a child reached by its first parent is that child's branch going
		// on, so the commit stays on it rather than on a line some merge opened.
		let lane =
			waiting.find((i) => lanes[i]?.fresh === false) ?? waiting[0] ?? -1;
		let claim: number | null = null;
		if (claimed.length > 0) {
			// Already on a line reserved ahead of its own claim — the default
			// branch's tip on HEAD's first-parent line — it stays there, and the
			// lane it reserved is free for anyone. Otherwise it takes its lane,
			// and whichever lines were heading for it converge there.
			const onEarlier = waiting.find((i) => {
				const occupant = lanes[i];
				return occupant !== null && occupant.line < claimed[0];
			});
			if (onEarlier !== undefined) {
				lane = onEarlier;
			} else {
				claim = claimed[0];
				lane = claim;
				while (lanes.length <= lane) lanes.push(null);
			}
		}
		const node = lane === -1 || claim !== null ? null : lanes[lane];
		// Children waiting on this commit converge here; their lanes are free from now on.
		const above: GraphEdge[] = [];
		for (const i of waiting) {
			const occupant = lanes[i];
			if (occupant) above.push({ from: i, to: lane, line: occupant.line });
			lanes[i] = null;
		}
		for (let i = 0; i < lanes.length; i++) {
			const occupant = lanes[i];
			if (occupant) above.push({ from: i, to: i, line: occupant.line });
		}

		if (lane === -1) lane = freeLane(lanes, pending);
		const line = claim ?? node?.line ?? nextLine++;

		const below: GraphEdge[] = [];
		for (let i = 0; i < lanes.length; i++) {
			const occupant = lanes[i];
			if (occupant) below.push({ from: i, to: i, line: occupant.line });
		}
		const parents = state.firstParent
			? commit.parents.slice(0, 1)
			: commit.parents;
		parents.forEach((parent, k) => {
			if (k === 0) {
				// Even when another lane already waits for this parent, the first
				// parent stays on this line: the two meet at the parent, where the
				// fork really is.
				lanes[lane] = { hash: parent, line, fresh: false };
				below.push({ from: lane, to: lane, line });
				return;
			}
			const existing = lanes.findIndex((o) => o?.hash === parent);
			if (existing !== -1) {
				const occupant = lanes[existing];
				if (occupant)
					below.push({ from: lane, to: existing, line: occupant.line });
				return;
			}
			const target = freeLane(lanes, pending);
			const merged = { hash: parent, line: nextLine++, fresh: true };
			lanes[target] = merged;
			below.push({ from: lane, to: target, line: merged.line });
		});
		while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

		rows.push({ hash: commit.hash, lane, line, above, below });
	}

	return {
		rows,
		state: { lanes, pending, nextLine, firstParent: state.firstParent },
	};
}

export interface FoldedRow {
	/** The node's column; `maxLanes` when it sits in the overflow column. */
	column: number;
	above: GraphEdge[];
	below: GraphEdge[];
	/**
	 * How many lanes this row has beyond `maxLanes`, all drawn as the one
	 * overflow column at index `maxLanes` and labelled `+N`; 0 when none.
	 */
	hidden: number;
}

/**
 * Fits a row into `maxLanes` columns (the caller's choice, from the screen
 * width). Lanes past the limit share one overflow column, so a line leaving
 * the visible lanes still visibly goes somewhere.
 */
export function foldRow(row: GraphRow, maxLanes: number): FoldedRow {
	const column = (lane: number) => Math.min(lane, maxLanes);
	const hiddenLanes = new Set<number>();
	const note = (lane: number) => {
		if (lane >= maxLanes) hiddenLanes.add(lane);
	};
	note(row.lane);
	// Edges that land on the same columns are drawn once, in the colour of the
	// one crossing the row's edge at the lowest lane. That end is the same set
	// of lanes in this row's `below` and the next row's `above`, so the overflow
	// column keeps its colour from one row to the next.
	const fold = (edges: GraphEdge[], boundary: "from" | "to") => {
		const folded = new Map<string, { edge: GraphEdge; lane: number }>();
		for (const edge of edges) {
			note(edge.from);
			note(edge.to);
			const from = column(edge.from);
			const to = column(edge.to);
			const key = `${from}:${to}`;
			const kept = folded.get(key);
			if (kept && kept.lane <= edge[boundary]) continue;
			folded.set(key, {
				edge: { from, to, line: edge.line },
				lane: edge[boundary],
			});
		}
		return [...folded.values()].map(({ edge }) => edge);
	};
	const above = fold(row.above, "from");
	const below = fold(row.below, "to");
	return { column: column(row.lane), above, below, hidden: hiddenLanes.size };
}
