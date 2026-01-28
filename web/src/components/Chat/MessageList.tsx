import { ArrowDown } from "lucide-react";
import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { type Components, Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type {
	AskUserQuestionRequest,
	Message,
	PermissionRequest,
} from "../../types/message";
import MessageItem, { type PermissionChoice } from "./MessageItem";

interface Props {
	messages: Message[];
	isProcessRunning: boolean;
	onPermissionRespond?: (
		request: PermissionRequest,
		choice: PermissionChoice,
	) => void;
	onQuestionRespond?: (
		request: AskUserQuestionRequest,
		answers: Record<string, string> | null,
	) => void;
}

// Custom scroller: prevent horizontal overflow
const Scroller = forwardRef<HTMLDivElement, React.ComponentPropsWithRef<"div">>(
	(props, ref) => (
		<div
			{...props}
			ref={ref}
			className="overscroll-contain"
			style={{ ...props.style, overflowX: "hidden" }}
		/>
	),
);
Scroller.displayName = "Scroller";

// Custom list container: horizontal padding
const List = forwardRef<HTMLDivElement, React.ComponentPropsWithRef<"div">>(
	(props, ref) => <div {...props} ref={ref} className="px-3 sm:px-4" />,
);
List.displayName = "List";

const virtuosoComponents: Components<Message> = {
	Scroller,
	List,
};

function MessageList({
	messages,
	isProcessRunning,
	onPermissionRespond,
	onQuestionRespond,
}: Props) {
	const virtuosoRef = useRef<VirtuosoHandle>(null);
	const [showScrollButton, setShowScrollButton] = useState(false);
	const isAtBottomRef = useRef(true);

	// Shiki syntax highlighting loads async and changes content height.
	// Force scroll-to-bottom for 500ms to ensure we stay at bottom during this.
	const forceScrollToBottomRef = useRef(true);
	useEffect(() => {
		forceScrollToBottomRef.current = true;
		const timer = setTimeout(() => {
			forceScrollToBottomRef.current = false;
		}, 500);
		return () => clearTimeout(timer);
	}, []);

	const handleTotalListHeightChanged = useCallback(() => {
		if (isAtBottomRef.current || forceScrollToBottomRef.current) {
			virtuosoRef.current?.scrollToIndex({
				index: "LAST",
				align: "end",
			});
		}
	}, []);

	const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
		isAtBottomRef.current = atBottom;
		setShowScrollButton(!atBottom);
	}, []);

	const followOutput = useCallback((isAtBottom: boolean) => isAtBottom, []);

	const handleScrollToBottom = useCallback(() => {
		virtuosoRef.current?.scrollToIndex({
			index: "LAST",
			align: "end",
			behavior: "smooth",
		});
	}, []);

	const computeItemKey = useCallback(
		(_index: number, message: Message) => message.id,
		[],
	);

	const itemContent = useCallback(
		(index: number, message: Message) => (
			<div className="py-1.5 sm:py-2">
				<MessageItem
					message={message}
					isLast={index === messages.length - 1}
					isProcessRunning={isProcessRunning}
					onPermissionRespond={onPermissionRespond}
					onQuestionRespond={onQuestionRespond}
				/>
			</div>
		),
		[messages.length, isProcessRunning, onPermissionRespond, onQuestionRespond],
	);

	if (messages.length === 0) {
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center text-th-text-muted">
				<p>Start a conversation...</p>
			</div>
		);
	}

	return (
		<div className="relative min-h-0 flex-1 overflow-hidden">
			<Virtuoso
				ref={virtuosoRef}
				data={messages}
				computeItemKey={computeItemKey}
				itemContent={itemContent}
				components={virtuosoComponents}
				// Start scrolled to bottom
				initialTopMostItemIndex={messages.length - 1}
				// Align items to bottom when list is shorter than viewport
				alignToBottom
				// Auto-scroll when new items added (only if already at bottom)
				followOutput={followOutput}
				// Track scroll position for button visibility
				atBottomStateChange={handleAtBottomStateChange}
				// Re-scroll on height changes (async content like shiki)
				totalListHeightChanged={handleTotalListHeightChanged}
				// Consider "at bottom" if within 50px of bottom
				atBottomThreshold={50}
				className="h-full"
			/>

			{showScrollButton && (
				<button
					type="button"
					onClick={handleScrollToBottom}
					className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-th-border bg-th-bg-primary p-2 text-th-text-secondary shadow-xl transition-colors hover:bg-th-bg-secondary hover:text-th-text-primary"
					aria-label="Scroll to bottom"
				>
					<ArrowDown className="h-5 w-5" aria-hidden="true" />
				</button>
			)}
		</div>
	);
}

export default MessageList;
