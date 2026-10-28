import { useHasFinePointer } from "@pockode/shared";
import { Cloud, GitBranch, Tag } from "lucide-react";
import type { RefChip } from "../../lib/commitHistory";

interface Props {
	chips: RefChip[];
	/** How many to draw before `+N`. */
	limit: number;
	/** The commit's line colour, the bar that ties a chip to its line. */
	color: string;
	/**
	 * How far a chip's name may run before it truncates: a phone's text column
	 * gives up width sooner, and a commit's page, where chips wrap, only at
	 * its own edge.
	 */
	width: ChipWidth;
}

type ChipWidth = "narrow" | "wide" | "full";

const MAX_WIDTH: Record<ChipWidth, string> = {
	narrow: "max-w-[6rem]",
	wide: "max-w-[7.5rem]",
	full: "max-w-full",
};

/**
 * A row's ref markers, at the start of its second line. What a chip names is
 * told by its icon, never by its colour (docs/git-history-ui.md#ref-markers).
 *
 * `+N` is not a control: the whole row is the button that opens the commit,
 * where every ref is listed. Under a fine pointer it carries a `title` with
 * the names it hides, which hover may add and nothing needs.
 */
function RefChips({ chips, limit, color, width }: Props) {
	const finePointer = useHasFinePointer();
	if (chips.length === 0) return null;
	const shown = chips.slice(0, limit);
	const hidden = chips.slice(limit);

	return (
		<>
			{shown.map((chip) => (
				<Chip
					key={`${chip.kind}:${chip.name}`}
					chip={chip}
					color={color}
					width={width}
				/>
			))}
			{hidden.length > 0 && (
				<span
					className="shrink-0 tabular-nums text-th-text-muted"
					title={
						finePointer
							? hidden.flatMap((chip) => chip.names).join(", ") || undefined
							: undefined
					}
				>
					+{hidden.length}
				</span>
			)}
		</>
	);
}

const KIND_WORDS: Record<RefChip["kind"], string> = {
	head: "Detached",
	current: "Current branch",
	branch: "Branch",
	remote: "Remote branch",
	tag: "Tag",
};

function Chip({
	chip,
	color,
	width,
}: {
	chip: RefChip;
	color: string;
	width: ChipWidth;
}) {
	const here = chip.kind === "current" || chip.kind === "head";
	const Icon =
		chip.kind === "remote" ? Cloud : chip.kind === "tag" ? Tag : GitBranch;
	return (
		<span
			className={`flex min-w-0 shrink-0 items-center gap-1 overflow-hidden rounded bg-th-bg-tertiary pr-1 leading-4 ${MAX_WIDTH[width]} ${
				here
					? "font-medium text-th-text-primary ring-1 ring-th-accent ring-inset"
					: "text-th-text-secondary"
			}`}
		>
			<span
				className="w-0.5 shrink-0 self-stretch"
				style={{ backgroundColor: color }}
			/>
			{chip.kind !== "head" && (
				<Icon className="size-3 shrink-0" aria-hidden="true" />
			)}
			{/* The icon and the outline, in words: a row's button has a name of
			    its own, but the commit's page has only these. */}
			<span className="sr-only">{KIND_WORDS[chip.kind]} </span>
			{/* Truncated at the head, like every branch name in the workspace. */}
			<span className="min-w-0 truncate [direction:rtl]">
				<bdi dir="ltr">{chip.name}</bdi>
			</span>
			{chip.pushed && (
				<>
					<Cloud className="size-3 shrink-0" aria-hidden="true" />
					<span className="sr-only">, pushed</span>
				</>
			)}
		</span>
	);
}

export default RefChips;
