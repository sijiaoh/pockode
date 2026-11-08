import { memo } from "react";
import { foldRow, type GraphEdge, type GraphRow } from "../../lib/commitGraph";
import {
	LANE_WIDTH,
	lineColor,
	OVERFLOW_WIDTH,
	ROW_HEIGHT,
} from "../../lib/commitHistory";

const MID = ROW_HEIGHT / 2;
const STROKE = 2;

interface Dot {
	unpushed: boolean;
	merge: boolean;
}

/** Outer radius of a dot's shape: where lines meeting it stop. */
function dotRadius({ unpushed, merge }: Dot): number {
	if (merge) return 6;
	return unpushed ? 4.5 : 4;
}

/**
 * Fill says pushed, a second ring says merge; a ring is empty inside so the
 * row's own background shows through (docs/git-history-ui.md#dots).
 */
function DotShape({ x, color, dot }: { x: number; color: string; dot: Dot }) {
	if (dot.merge) {
		return (
			<g>
				<circle
					cx={x}
					cy={MID}
					r={5.25}
					fill="none"
					stroke={color}
					strokeWidth={1.5}
				/>
				{dot.unpushed ? (
					<circle
						cx={x}
						cy={MID}
						r={2.25}
						fill="none"
						stroke={color}
						strokeWidth={1.5}
					/>
				) : (
					<circle cx={x} cy={MID} r={2.5} fill={color} />
				)}
			</g>
		);
	}
	return dot.unpushed ? (
		<circle
			cx={x}
			cy={MID}
			r={3.5}
			fill="none"
			stroke={color}
			strokeWidth={STROKE}
		/>
	) : (
		<circle cx={x} cy={MID} r={4} fill={color} />
	);
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
	if (x1 === x2) return `M${x1} ${y1}V${y2}`;
	const ym = (y1 + y2) / 2;
	return `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`;
}

interface Props {
	row: GraphRow;
	/** Lanes drawn before the `+N` slot. */
	cap: number;
	width: number;
	dot: Dot;
}

/**
 * One row of the commit graph: the lines through it, its commit's dot, and
 * `+N` where lines run past the cap.
 *
 * A line between a drawn lane and a hidden one stops at the slot's edge; a
 * line between two hidden ones is not drawn at all. Only a dot of its own in
 * the slot is reached there (docs/git-history-ui.md#lane-cap).
 */
function CommitGraphCell({ row, cap, width, dot }: Props) {
	const folded = foldRow(row, cap);
	const slotEdge = cap * LANE_WIDTH;
	const slotCentre = slotEdge + OVERFLOW_WIDTH / 2;
	const nodeHidden = folded.column === cap;
	const nodeX = nodeHidden ? slotCentre : folded.column * LANE_WIDTH + 7;
	const radius = dotRadius(dot);

	// A lane past the cap is drawn as the slot's edge, except where the
	// commit's own dot sits in the slot.
	const x = (column: number) =>
		column < cap ? column * LANE_WIDTH + 7 : slotEdge;

	const path = (edge: GraphEdge, half: "above" | "below") => {
		if (edge.from >= cap && edge.to >= cap) return null;
		if (half === "above") {
			const toNode = edge.to === folded.column;
			return curve(
				x(edge.from),
				0,
				toNode ? nodeX : x(edge.to),
				toNode ? MID - radius : MID,
			);
		}
		const fromNode = edge.from === folded.column;
		return curve(
			fromNode ? nodeX : x(edge.from),
			fromNode ? MID + radius : MID,
			x(edge.to),
			ROW_HEIGHT,
		);
	};

	const color = lineColor(row.line);
	return (
		<svg
			width={width}
			height={ROW_HEIGHT}
			className="shrink-0"
			aria-hidden="true"
			focusable="false"
		>
			{folded.above.map((edge) => {
				const d = path(edge, "above");
				return (
					d && (
						<path
							key={`a${edge.from}:${edge.to}`}
							d={d}
							fill="none"
							stroke={lineColor(edge.line)}
							strokeWidth={STROKE}
						/>
					)
				);
			})}
			{folded.below.map((edge) => {
				const d = path(edge, "below");
				return (
					d && (
						<path
							key={`b${edge.from}:${edge.to}`}
							d={d}
							fill="none"
							stroke={lineColor(edge.line)}
							strokeWidth={STROKE}
						/>
					)
				);
			})}
			{folded.hidden > 0 && !nodeHidden && (
				<text
					x={slotCentre}
					y={MID}
					textAnchor="middle"
					dominantBaseline="central"
					className="fill-th-text-muted text-[10px] tabular-nums"
				>
					+{folded.hidden}
				</text>
			)}
			<DotShape x={nodeX} color={color} dot={dot} />
		</svg>
	);
}

/**
 * The single lane of a filtered list: a dot per commit and no lines, which
 * would join commits that are not each other's parents. Muted, since there is
 * no line to take a colour from.
 */
export function LoneDotCell({ dot }: { dot: Dot }) {
	return (
		<svg
			width={LANE_WIDTH}
			height={ROW_HEIGHT}
			className="shrink-0 text-th-text-muted"
			aria-hidden="true"
			focusable="false"
		>
			<DotShape x={7} color="currentColor" dot={dot} />
		</svg>
	);
}

export default memo(CommitGraphCell);
