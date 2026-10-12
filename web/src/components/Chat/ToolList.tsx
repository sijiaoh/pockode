import {
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import { oldestPart, partBlocks } from "../../lib/partTree";
import { rowEntries } from "../../lib/toolGroups";
import type { ContentPart } from "../../types/message";
import { RowExpansionContext, RowFrameContext } from "./rowExpansionContext";
import { ToolGroupSummary } from "./ToolGroupSummary";
import { OpenedThoughtsContext } from "./turnTailContext";
import { foldPlaceProps } from "./useFoldLanding";

interface Item {
	part: ContentPart;
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

interface SlotProps {
	rowKey: string;
	framed: boolean;
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
	framed,
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
			className={framed ? "border-t border-th-border" : undefined}
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
 * One list — framed, unless it holds nothing but a thinking — with each run
 * of calls that folds drawn as a summary row over its members
 * (docs/tool-call-ui.md#groups). Holds two things the rows cannot: which
 * groups are open, and which rows the user opened — a row the user is reading
 * stays in sight when its group closes or forms over it, until they close it
 * themselves.
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

	// What the user chose for a row belongs to its call: the row rebuilt once a
	// card is answered is a new part, and opens as the one the card replaced
	// was left. The card itself keeps that row's id but not its choice: a
	// pending card opens itself.
	const choiceKey = (part: ContentPart) =>
		part.type === "tool_call"
			? `tool_call:${part.tool.id}`
			: `${part.type}:${part.id}`;
	// A thinking the user opened while it was still the tail line is a choice
	// they made before the row existed.
	const openedThoughts = useContext(OpenedThoughtsContext);
	const choiceFor = (part: ContentPart) =>
		choices.get(choiceKey(part)) ?? (openedThoughts.has(part.id) || undefined);

	const entries = rowEntries(items);
	// A card and its row are one call, shown and hidden together.
	const openedCalls = new Set(
		entries.flatMap((entry) =>
			entry.kind === "item" && choiceFor(entry.item.part) ? [entry.call] : [],
		),
	);

	// A list of nothing but a thinking is not framed: it is drawn bare, on the
	// text's left edge like the tail line it settles from, so `Thinking…`
	// becoming `Thought for 12s` grows no box around it and does not move.
	const framed = items.some((item) => item.part.type !== "thinking");

	return (
		<RowFrameContext value={framed}>
			<div
				// `overflow-clip`, not `overflow-hidden`: both cut the rows to the
				// rounded frame, but `hidden` also makes the list a scroll container,
				// and an open row's bar would then stick to the list — which never
				// scrolls — instead of to the transcript.
				className={
					framed
						? "overflow-clip rounded-lg border border-th-border text-xs"
						: "text-xs"
				}
			>
				<div className={framed ? "-mt-px" : undefined}>
					{entries.map((entry) => {
						if (entry.kind === "summary") {
							return (
								<div
									key={entry.key}
									className="border-t border-th-border"
									{...wrapperProps}
									{...foldPlaceProps}
								>
									<ToolGroupSummary
										summary={entry.summary}
										expanded={openGroups.has(entry.key)}
										onToggle={() => toggleGroup(entry.key)}
									/>
								</div>
							);
						}
						const { part } = entry.item;
						const hidden =
							entry.group !== undefined &&
							!openGroups.has(entry.group) &&
							!openedCalls.has(entry.call);
						return (
							<RowSlot
								key={part.id}
								rowKey={choiceKey(part)}
								framed={framed}
								choice={choiceFor(part)}
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
		</RowFrameContext>
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
			return (
				<div key={block.item.part.id} {...wrapperProps}>
					{renderPart(block.item)}
				</div>
			);
		}
		return (
			<RowList
				key={`rows:${oldestPart(block.items).part.id}`}
				items={block.items}
				renderPart={renderPart}
				wrapperProps={wrapperProps}
			/>
		);
	});
}
