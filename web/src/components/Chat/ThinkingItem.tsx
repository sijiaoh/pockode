import { Brain } from "lucide-react";
import { memo, useContext, useMemo } from "react";
import type { FullScreenSource } from "../../lib/fullScreen";
import { hasText, spokenThoughtLabel, thoughtLabel } from "../../lib/thinking";
import type { Thought } from "../../types/message";
import { CollapsibleBody, MarkdownContent } from "../ui";
import { BareBody, BareRow } from "./BareRow";
import { HeaderlessMainBlock } from "./HeaderlessMainBlock";
import { RowFrameContext, useRowExpanded } from "./rowExpansionContext";
import { Chip, RowButton, StaticRow } from "./ToolRow";
import { Section, type SectionFullScreen } from "./ToolSection";
import { useTranscriptView } from "./transcriptViewContext";

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
function thoughtOpening(text: string): string {
	let end = -1;
	for (let n = 0; n < 6; n++) {
		end = text.indexOf("\n", end + 1);
		if (end === -1) return text.slice(0, 200);
	}
	return text.slice(0, Math.min(end, 200));
}

/**
 * What a thought's text is published under in full screen. A thought has no
 * id, and is drawn first in the turn's tail and then in its row: its opening is
 * what stays the same across the move. Full screen is offered only once the
 * block is cut, past a dozen rows — 200 characters, or short lines of which the
 * first six are whole — so by then the opening no longer changes as it
 * streams; two texts sharing all of it would be the same reasoning.
 */
function thoughtKey(text: string): string {
	return `thought:${hashText(thoughtOpening(text))}`;
}

/**
 * A thought's unlabelled text, cut like a plan or a report. Live, it is read
 * from its newest line and follows it, as a command's output so far does.
 */
function ThoughtBlock({ text, live }: { text: string; live: boolean }) {
	const view = useTranscriptView();
	const from = live ? "end" : "start";
	const source = useMemo<FullScreenSource>(
		() => ({
			title: "Thinking",
			label: "Thinking",
			noun: "thinking",
			from,
			copyText: text,
			content: { kind: "markdown", markdown: text },
		}),
		[text, from],
	);
	return (
		<HeaderlessMainBlock
			name="thinking"
			fullScreenKey={thoughtKey(text)}
			source={source}
			view={view}
			follow={live}
		>
			<ThoughtText content={text} />
		</HeaderlessMainBlock>
	);
}

/**
 * One record's share of the body. Codex's raw reasoning goes under a label
 * only beside a summary; alone it is the body, and nothing is labelled twice.
 * Also the live tail's body — no record yet and so no id — which is `live`.
 */
export function ThoughtBody({
	thought,
	live = false,
}: {
	thought: Omit<Thought, "id">;
	live?: boolean;
}) {
	const reasoning = thought.fullReasoning;
	const fullScreen = useMemo<SectionFullScreen>(
		() => ({
			key: thoughtKey(reasoning),
			title: "Reasoning",
			content: { kind: "markdown", markdown: reasoning },
		}),
		[reasoning],
	);
	if (!hasText(thought)) {
		return <p className="text-th-text-muted">Hidden by the model provider.</p>;
	}
	if (!thought.content || !thought.fullReasoning) {
		return (
			<ThoughtBlock
				text={thought.content || thought.fullReasoning}
				live={live}
			/>
		);
	}
	return (
		<div className="space-y-3">
			<ThoughtBlock text={thought.content} live={live} />
			<Section
				label="Full reasoning"
				noun="reasoning"
				budget="main"
				clampFrom={live ? "end" : undefined}
				follow={live}
				fullScreen={fullScreen}
			>
				<ThoughtText content={thought.fullReasoning} />
			</Section>
		</div>
	);
}

/**
 * Where a thought's body starts, here and in the live turn's tail. A thinking
 * row has no bar pinned over its body, so an opened "Full reasoning" pins its
 * header (`section-bar`) under the bar of a subagent's row it sits in, or at
 * the transcript's top.
 */
export const THOUGHT_BODY = "[--section-bar-top:var(--row-bar-above,0px)]";

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
	const records = shown.map((thought) => (
		<div key={thought.id} className="py-2">
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
					<div
						className={`divide-y divide-th-border border-t border-th-border bg-th-bg-secondary px-2 ${THOUGHT_BODY}`}
					>
						{records}
					</div>
				) : (
					<BareBody>
						<div className={`divide-y divide-th-border px-2.5 ${THOUGHT_BODY}`}>
							{records}
						</div>
					</BareBody>
				)}
			</CollapsibleBody>
		</div>
	);
});

export default ThinkingItem;
