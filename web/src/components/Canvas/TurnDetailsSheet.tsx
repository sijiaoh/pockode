import { Sheet } from "@pockode/shared";
import { useLayoutEffect, useRef } from "react";
import type { TurnTail } from "../../lib/thinking";
import type {
	AssistantMessage,
	Message,
	PermissionRequest,
	UserMessage,
} from "../../types/message";
import MessageItem, { type PromptError } from "../Chat/MessageItem";
import type { PermissionChoice } from "../Chat/PermissionRequestItem";
import { TurnClock } from "../Chat/TurnTail";
import {
	OpenedThoughtsContext,
	TurnTailContext,
} from "../Chat/turnTailContext";
import {
	UnfiledChildrenContext,
	useUnfiledChildrenValue,
} from "../Chat/unfiledChildrenContext";

interface Props {
	sessionId: string;
	/** The transcript the reply is from, for its subagents' unfiled children. */
	messages: Message[];
	reply: AssistantMessage;
	/** The message the reply answers, drawn above it. */
	prompt?: UserMessage;
	turnOpen: boolean;
	running: boolean;
	/** The reply is the one the open turn writes into; see `MessageItem`. */
	isOpenTurn: boolean;
	tail: TurnTail;
	openedThoughtIds: ReadonlySet<string>;
	isCodex: boolean;
	onPermissionRespond?: (
		request: PermissionRequest,
		choice: PermissionChoice,
	) => void;
	promptError?: PromptError;
	onOpenFile?: (path: string) => void;
	onClose: () => void;
	onOpenInChat: () => void;
}

// Within this of the end the reader is at it, as the transcript's own "near
// the end" is a little slack: a row settling a pixel shorter must not count
// as the reader leaving.
const AT_END_SLACK_PX = 24;

/**
 * Keeps the sheet's body at its end while the reader is there, as chat does:
 * rows arrive and settle in it, and a reader who scrolled up to read is left
 * where they are. Opened at the end — what the strip said is the latest item.
 */
function useFollowEnd(contentRef: React.RefObject<HTMLDivElement | null>) {
	useLayoutEffect(() => {
		const content = contentRef.current;
		// The sheet's body is the scroller, and this is its one child.
		const scroller = content?.parentElement;
		if (!content || !scroller) return;
		let atEnd = true;
		const follow = () => {
			if (atEnd) scroller.scrollTop = scroller.scrollHeight;
		};
		const onScroll = () => {
			atEnd =
				scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <=
				AT_END_SLACK_PX;
		};
		follow();
		scroller.addEventListener("scroll", onScroll, { passive: true });
		const observer = new ResizeObserver(follow);
		observer.observe(content);
		return () => {
			scroller.removeEventListener("scroll", onScroll);
			observer.disconnect();
		};
	}, [contentRef]);
}

/**
 * The reply the activity strip speaks for, as chat draws it
 * (docs/canvas-ui.md §11.3): the same `MessageItem`s from the same
 * transcript, so it is live, without the per-message actions chat view has.
 */
function TurnDetailsSheet({
	sessionId,
	messages,
	reply,
	prompt,
	turnOpen,
	running,
	isOpenTurn,
	tail,
	openedThoughtIds,
	isCodex,
	onPermissionRespond,
	promptError,
	onOpenFile,
	onClose,
	onOpenInChat,
}: Props) {
	const contentRef = useRef<HTMLDivElement>(null);
	useFollowEnd(contentRef);
	const unfiled = useUnfiledChildrenValue(messages);

	return (
		<Sheet
			title={turnOpen ? "Current turn" : "Last turn"}
			// Held at a line's height for the whole turn, as the clock shows
			// only from its third second: the header must not move under the
			// reader.
			subtitle={
				turnOpen ? (
					<span className="block min-h-4 text-xs leading-4">
						{running && tail.openedAt !== undefined && (
							<TurnClock openedAt={tail.openedAt} />
						)}
					</span>
				) : undefined
			}
			onClose={onClose}
			footer={
				<button
					type="button"
					onClick={onOpenInChat}
					className="flex-1 rounded-lg bg-th-bg-tertiary px-4 py-2.5 text-sm text-th-text-primary transition-opacity hover:opacity-90"
				>
					Open in chat
				</button>
			}
		>
			<div ref={contentRef} className="space-y-3 p-4">
				<TurnTailContext value={tail}>
					<OpenedThoughtsContext value={openedThoughtIds}>
						<UnfiledChildrenContext value={unfiled}>
							{prompt && (
								<MessageItem
									message={prompt}
									sessionId={sessionId}
									onOpenFile={onOpenFile}
								/>
							)}
							<MessageItem
								message={reply}
								sessionId={sessionId}
								isOpenTurn={isOpenTurn}
								isCodex={isCodex}
								onPermissionRespond={onPermissionRespond}
								promptError={promptError}
								onOpenFile={onOpenFile}
								withoutActions
							/>
						</UnfiledChildrenContext>
					</OpenedThoughtsContext>
				</TurnTailContext>
			</div>
		</Sheet>
	);
}

export default TurnDetailsSheet;
