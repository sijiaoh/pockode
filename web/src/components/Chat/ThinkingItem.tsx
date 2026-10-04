import { Brain } from "lucide-react";
import { memo } from "react";
import { hasText, spokenThoughtLabel, thoughtLabel } from "../../lib/thinking";
import type { Thought } from "../../types/message";
import { CollapsibleBody, MarkdownContent, ScrollableContent } from "../ui";
import { useRowExpanded } from "./rowExpansionContext";
import { Chip, RowButton, StaticRow } from "./ToolRow";
import { Section } from "./ToolSection";

interface Props {
	thoughts: Thought[];
}

const GLYPH = <Brain className="mt-0.5 size-3 shrink-0 text-th-text-muted" />;

/**
 * Thinking is the agent's prose, read at the text's own size and in secondary
 * colour — markers included, through `prose-inherit-color`, which unlike a
 * utility still wins over `dark:prose-invert` (src/index.css).
 */
function ThoughtText({ content }: { content: string }) {
	return (
		<MarkdownContent
			content={content}
			className="prose-inherit-color text-th-text-secondary"
		/>
	);
}

/**
 * One record's share of the body. Codex's raw reasoning goes under a label
 * only beside a summary; alone it is the body, and nothing is labelled twice.
 */
export function ThoughtBody({ thought }: { thought: Thought }) {
	if (!hasText(thought)) {
		return <p className="text-th-text-muted">Hidden by the model provider.</p>;
	}
	if (!thought.content || !thought.fullReasoning) {
		return <ThoughtText content={thought.content || thought.fullReasoning} />;
	}
	return (
		<div className="space-y-3">
			<ThoughtText content={thought.content} />
			<Section label="Full reasoning">
				<ThoughtText content={thought.fullReasoning} />
			</Section>
		</div>
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
	const label = thoughtLabel(thoughts);
	const spoken = spokenThoughtLabel(thoughts);

	if (!thoughts.some(hasText)) {
		const redacted = thoughts.some((thought) => thought.redacted);
		return (
			<StaticRow glyph={GLYPH}>
				<span aria-hidden className="flex items-baseline gap-1.5">
					<span className="truncate text-th-text-secondary">{label}</span>
					{redacted && <Chip>hidden</Chip>}
				</span>
				<span className="sr-only">
					{redacted
						? `${spoken}, content hidden by the model provider`
						: `${spoken}, no content shared`}
				</span>
			</StaticRow>
		);
	}

	// An empty record contributes nothing; a redacted one stands in its place.
	const shown = thoughts.filter(
		(thought) => hasText(thought) || thought.redacted,
	);
	return (
		<div className="text-xs">
			<RowButton
				expanded={expanded}
				onToggle={() => setExpanded(!expanded)}
				glyph={GLYPH}
				label={spoken}
			>
				<span className="block truncate text-th-text-secondary">{label}</span>
			</RowButton>
			<CollapsibleBody expanded={expanded}>
				<ScrollableContent className="max-h-[60vh] divide-y divide-th-border overflow-auto border-t border-th-border bg-th-bg-secondary px-2">
					{shown.map((thought, index) => (
						// Records only ever append, so the position is the identity.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above
						<div key={index} className="py-2">
							<ThoughtBody thought={thought} />
						</div>
					))}
				</ScrollableContent>
			</CollapsibleBody>
		</div>
	);
});

export default ThinkingItem;
