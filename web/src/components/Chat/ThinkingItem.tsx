import { Brain } from "lucide-react";
import { memo, type ReactNode, useContext, useMemo, useRef } from "react";
import { hasText, spokenThoughtLabel, thoughtLabel } from "../../lib/thinking";
import type { Thought } from "../../types/message";
import { CollapsibleBody, MarkdownContent, ScrollableContent } from "../ui";
import { BareBody, BareRow } from "./BareRow";
import { RowFrameContext, useRowExpanded } from "./rowExpansionContext";
import { Chip, RowButton, StaticRow } from "./ToolRow";
import { Section, type SectionFullScreen } from "./ToolSection";
import {
	TranscriptViewContext,
	useScrollerView,
} from "./transcriptViewContext";

interface Props {
	thoughts: Thought[];
}

const GLYPH = <Brain className="mt-0.5 size-3 shrink-0 text-th-text-muted" />;

/** A short stable name for a text, for a key that also goes into the DOM. */
function hashText(text: string): string {
	let hash = 5381;
	for (let i = 0; i < text.length; i++) {
		hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

/**
 * Thinking is drawn as a note — a tool row's size, in secondary colour — the
 * way a subagent's words are, and for the same reason: opened in the middle of
 * a reply, it must not read as the agent answering.
 */
function ThoughtText({ content }: { content: string }) {
	return <MarkdownContent content={content} variant="note" />;
}

/** The first 200 characters, or the first six lines if they end sooner. */
function thoughtOpening(reasoning: string): string {
	let end = -1;
	for (let n = 0; n < 6; n++) {
		end = reasoning.indexOf("\n", end + 1);
		if (end === -1) return reasoning.slice(0, 200);
	}
	return reasoning.slice(0, Math.min(end, 200));
}

/**
 * One record's share of the body. Codex's raw reasoning goes under a label
 * only beside a summary; alone it is the body, and nothing is labelled twice.
 */
export function ThoughtBody({ thought }: { thought: Thought }) {
	const reasoning = thought.fullReasoning;
	const fullScreen = useMemo<SectionFullScreen>(
		() => ({
			// A thought has no id, and is drawn first in the turn's tail and then
			// in its row: its opening is what stays the same across the move.
			// Full screen is offered only once the block is cut, past a dozen
			// rows — 200 characters, or short lines of which the first six are
			// whole — so by then the opening no longer changes as it streams;
			// two thoughts sharing all of it would be the same reasoning.
			key: `thought:${hashText(thoughtOpening(reasoning))}`,
			title: "Reasoning",
			content: { kind: "markdown", markdown: reasoning },
		}),
		[reasoning],
	);
	if (!hasText(thought)) {
		return <p className="text-th-text-muted">Hidden by the model provider.</p>;
	}
	if (!thought.content || !thought.fullReasoning) {
		return <ThoughtText content={thought.content || thought.fullReasoning} />;
	}
	return (
		<div className="space-y-3">
			<ThoughtText content={thought.content} />
			<Section
				label="Full reasoning"
				noun="reasoning"
				budget="main"
				fullScreen={fullScreen}
			>
				<ThoughtText content={thought.fullReasoning} />
			</Section>
		</div>
	);
}

/**
 * The box a thought's records scroll in, here and in the live turn's tail. A
 * scroller of its own with no row bar over it: an opened "Full reasoning" pins
 * its header at the scroller's top (`section-bar`), and opening and closing it
 * keep the place in this scroller rather than in the transcript. No vertical
 * padding of its own, which a pinned header would leave a gap above.
 */
export function ThoughtScroller({
	className,
	children,
}: {
	className: string;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const view = useScrollerView(ref);
	return (
		<TranscriptViewContext value={view}>
			<ScrollableContent
				ref={ref}
				className={`max-h-[60vh] overflow-auto [--section-bar-top:0px] ${className}`}
			>
				{children}
			</ScrollableContent>
		</TranscriptViewContext>
	);
}

/**
 * What the agent thought, as one muted row in the list
 * (docs/turn-progress-ui.md#1-the-thinking-row). Told from a tool row by what
 * it lacks: no accent title, no detail, no meta — the duration is in the
 * title, where it reads as a sentence.
 */
const ThinkingItem = memo(function ThinkingItem({ thoughts }: Props) {
	const [expanded, setExpanded] = useRowExpanded();
	const framed = useContext(RowFrameContext);
	const label = thoughtLabel(thoughts);
	const spoken = spokenThoughtLabel(thoughts);

	if (!thoughts.some(hasText)) {
		const redacted = thoughts.some((thought) => thought.redacted);
		const words = (
			<>
				<span aria-hidden className="flex items-baseline gap-1.5">
					<span className="min-w-0 truncate text-th-text-secondary">
						{label}
					</span>
					{redacted && <Chip>hidden</Chip>}
				</span>
				<span className="sr-only">
					{redacted
						? `${spoken}, content hidden by the model provider`
						: `${spoken}, no content shared`}
				</span>
			</>
		);
		return framed ? (
			<StaticRow glyph={GLYPH}>{words}</StaticRow>
		) : (
			<BareRow glyph={GLYPH}>{words}</BareRow>
		);
	}

	// An empty record contributes nothing; a redacted one stands in its place.
	const shown = thoughts.filter(
		(thought) => hasText(thought) || thought.redacted,
	);
	const toggle = () => setExpanded(!expanded);
	const words = (
		<span className="block truncate text-th-text-secondary">{label}</span>
	);
	const records = shown.map((thought, index) => (
		// Records only ever append, so the position is the identity.
		// biome-ignore lint/suspicious/noArrayIndexKey: see above
		<div key={index} className="py-2">
			<ThoughtBody thought={thought} />
		</div>
	));
	return (
		<div className="text-xs">
			{framed ? (
				<RowButton
					expanded={expanded}
					onToggle={toggle}
					glyph={GLYPH}
					label={spoken}
				>
					{words}
				</RowButton>
			) : (
				<BareRow
					glyph={GLYPH}
					toggle={{ expanded, onToggle: toggle, label: spoken }}
				>
					{words}
				</BareRow>
			)}
			<CollapsibleBody expanded={expanded}>
				{framed ? (
					<ThoughtScroller className="divide-y divide-th-border border-t border-th-border bg-th-bg-secondary px-2">
						{records}
					</ThoughtScroller>
				) : (
					<BareBody>
						<ThoughtScroller className="divide-y divide-th-border px-2.5">
							{records}
						</ThoughtScroller>
					</BareBody>
				)}
			</CollapsibleBody>
		</div>
	);
});

export default ThinkingItem;
