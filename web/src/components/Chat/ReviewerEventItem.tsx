import { Bot, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { FullScreenSource } from "../../lib/fullScreen";
import {
	nudgePendingCount,
	PERMISSION_REVIEW_SUBTYPE,
	parseReviewRequest,
} from "../../lib/reviewerTranscript";
import { outputLineCount } from "../../lib/textLines";
import { toolSummary, toolSummaryLine } from "../../lib/toolSummary";
import { CollapsibleBody } from "../ui";
import { HeaderlessMainBlock } from "./HeaderlessMainBlock";
import { useTranscriptView } from "./transcriptViewContext";

interface Props {
	/** The message's, naming its body in full screen. */
	id: string;
	content: string;
	/** `permission_review` or `permission_review_nudge`. */
	subtype: string;
	/** A Stop threw this message away before the reviewer read it. */
	discarded?: boolean;
}

/**
 * A message Pockode sent a permission reviewer — a request to judge, or a
 * reminder of ones left unanswered — drawn as an event line like a work
 * event, not as markdown: the request is data from the main session
 * (docs/unattended-mode-ui.md §5.1).
 */
function ReviewerEventItem({ id, content, subtype, discarded }: Props) {
	const [expanded, setExpanded] = useState(false);
	const view = useTranscriptView();
	const isRequest = subtype === PERMISSION_REVIEW_SUBTYPE;

	const { label, summary, mono, body } = useMemo(() => {
		if (!isRequest) {
			const count = nudgePendingCount(content);
			return {
				label: "Review reminder",
				summary:
					count === null
						? ""
						: count === 1
							? "1 request waiting"
							: `${count} requests waiting`,
				mono: false,
				body: content,
			};
		}
		const request = parseReviewRequest(content);
		if (!request) {
			return {
				label: "Permission review",
				summary: "",
				mono: false,
				body: content,
			};
		}
		// Relative to the main session's worktree as the request named it, not to
		// this page's: the same title the main session's card shows, so the two
		// can be matched by eye.
		const tool = toolSummary(request.toolName, request.toolInput, request.cwd);
		return {
			label: "Permission review",
			summary: toolSummaryLine(tool),
			mono: tool.mono,
			body: JSON.stringify(request.json, null, 2),
		};
	}, [isRequest, content]);

	const isJson = body !== content;
	const source = useMemo<FullScreenSource>(
		() => ({
			title: `Pockode · ${label}`,
			label: "Message",
			noun: "message",
			from: "start",
			copyText: body,
			content: isJson
				? { kind: "code", text: body, language: "json" }
				: { kind: "output", text: body },
		}),
		[label, body, isJson],
	);

	return (
		<div className="rounded bg-th-bg-secondary text-xs">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				aria-expanded={expanded}
				className="flex w-full items-center gap-1.5 rounded p-2 text-left hover:bg-th-overlay-hover"
			>
				<ChevronRight
					className={`size-3 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
					aria-hidden="true"
				/>
				<Bot
					className="size-3 shrink-0 text-th-text-muted"
					aria-hidden="true"
				/>
				<span className="shrink-0 text-th-text-muted">{`Pockode · ${label}`}</span>
				{summary && (
					<span
						className={`min-w-0 truncate text-th-text-muted ${mono ? "font-mono" : ""}`}
					>
						{summary}
					</span>
				)}
				{discarded && (
					<span className="shrink-0 text-th-text-muted">· not read</span>
				)}
			</button>
			<CollapsibleBody expanded={expanded}>
				<div className="border-t border-th-border p-2">
					<HeaderlessMainBlock
						name="message"
						fullScreenKey={`event:${id}`}
						source={source}
						view={view}
						count={{ noun: "line", total: outputLineCount(body) }}
					>
						<pre className="whitespace-pre-wrap break-words text-th-text-muted">
							{body}
						</pre>
					</HeaderlessMainBlock>
				</div>
			</CollapsibleBody>
		</div>
	);
}

export default ReviewerEventItem;
