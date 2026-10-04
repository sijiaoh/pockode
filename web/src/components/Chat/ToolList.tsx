import { type ReactNode, useCallback, useMemo, useState } from "react";
import { partBlocks, partKey } from "../../lib/partTree";
import { stepId } from "../../lib/subagentRun";
import { rowEntries } from "../../lib/toolGroups";
import type { ContentPart } from "../../types/message";
import { RowExpansionContext } from "./rowExpansionContext";
import { ToolGroupSummary } from "./ToolGroupSummary";

interface Item {
	part: ContentPart;
	/** The part's position in its own list, which its key falls back on. */
	index: number;
}

interface Props<T extends Item> {
	items: T[];
	renderPart: (item: T) => ReactNode;
	/**
	 * Spread onto every part's own wrapper, a row inside a list included — the
	 * main transcript marks each one as a scroll anchor candidate. A list is not
	 * one: it is several screens tall when its rows are open, which says nothing
	 * about where inside it the reader is.
	 */
	wrapperProps?: Record<string, string>;
}

/**
 * Which call a row stands for. A list keys on its first row's call rather than
 * on the part: Claude's card replaces the row of the call it asks about, in
 * place, and a list keyed on the part would remount every row in it — open
 * bodies closing — when the first one is replaced. `stepId` rather than the
 * card's bare `toolUseId`, which can be empty: two lists opening on such cards
 * would share a key.
 */
function callKey({ part, index }: Item): string {
	return stepId(part) ?? partKey(part, index);
}

interface SlotProps {
	rowKey: string;
	choice?: boolean;
	onChoice: (rowKey: string, expanded: boolean) => void;
	hidden: boolean;
	wrapperProps?: Record<string, string>;
	children: ReactNode;
}

/**
 * One part's place in a list. Hidden by the `hidden` attribute, not unmounted,
 * so a row folded into its group keeps its state and comes back as it was; and
 * not a scroll anchor candidate while hidden, since an element that is not
 * displayed measures as sitting at the very top.
 */
function RowSlot({
	rowKey,
	choice,
	onChoice,
	hidden,
	wrapperProps,
	children,
}: SlotProps) {
	const expansion = useMemo(
		() => ({
			choice,
			setChoice: (expanded: boolean) => onChoice(rowKey, expanded),
		}),
		[choice, onChoice, rowKey],
	);
	return (
		<div
			className="border-t border-th-border"
			hidden={hidden}
			{...(hidden ? undefined : wrapperProps)}
		>
			<RowExpansionContext.Provider value={expansion}>
				{children}
			</RowExpansionContext.Provider>
		</div>
	);
}

/**
 * One framed list, with each run of calls that folds drawn as a summary row
 * over its members (docs/tool-call-ui.md#groups). Holds two things the rows
 * cannot: which groups are open, and which rows the user opened — a row the
 * user is reading stays in sight when its group closes or forms over it, until
 * they close it themselves.
 */
function RowList<T extends Item>({
	items,
	renderPart,
	wrapperProps,
}: Props<T>) {
	const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
	const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(
		new Map(),
	);
	const onChoice = useCallback((rowKey: string, expanded: boolean) => {
		setChoices((current) => new Map(current).set(rowKey, expanded));
	}, []);
	const toggleGroup = (key: string) =>
		setOpenGroups((current) => {
			const next = new Set(current);
			if (!next.delete(key)) next.add(key);
			return next;
		});

	const entries = rowEntries(items);
	// A card and its row are one call, shown and hidden together.
	const openedCalls = new Set(
		entries.flatMap((entry) =>
			entry.kind === "item" &&
			choices.get(partKey(entry.item.part, entry.item.index))
				? [entry.call]
				: [],
		),
	);

	return (
		<div className="overflow-hidden rounded-lg border border-th-border text-xs">
			<div className="-mt-px">
				{entries.map((entry) => {
					if (entry.kind === "summary") {
						return (
							<div
								key={entry.key}
								className="border-t border-th-border"
								{...wrapperProps}
							>
								<ToolGroupSummary
									summary={entry.summary}
									expanded={openGroups.has(entry.key)}
									onToggle={() => toggleGroup(entry.key)}
								/>
							</div>
						);
					}
					const key = partKey(entry.item.part, entry.item.index);
					const hidden =
						entry.group !== undefined &&
						!openGroups.has(entry.group) &&
						!openedCalls.has(entry.call);
					return (
						<RowSlot
							key={key}
							rowKey={key}
							choice={choices.get(key)}
							onChoice={onChoice}
							hidden={hidden}
							wrapperProps={wrapperProps}
						>
							{renderPart(entry.item)}
						</RowSlot>
					);
				})}
			</div>
		</div>
	);
}

/**
 * A list of parts as the transcript draws it: consecutive rows in one outlined
 * list separated by hairlines, everything else on its own
 * (docs/tool-call-ui.md#the-list). Renders the blocks only; the caller's
 * container spaces them.
 *
 * Every row carries its own top border rather than the list using `divide-y`,
 * and the first one's is pulled up under the list's frame and clipped there: a
 * divider drawn between DOM siblings would also be drawn for a row that is
 * hidden, and a hidden last row would leave a doubled line at the bottom.
 */
export function PartBlocks<T extends Item>({
	items,
	renderPart,
	wrapperProps,
}: Props<T>) {
	return partBlocks(items).map((block) => {
		if (block.kind === "single") {
			const { part, index } = block.item;
			return (
				<div key={partKey(part, index)} {...wrapperProps}>
					{renderPart(block.item)}
				</div>
			);
		}
		return (
			<RowList
				key={`rows:${callKey(block.items[0])}`}
				items={block.items}
				renderPart={renderPart}
				wrapperProps={wrapperProps}
			/>
		);
	});
}
