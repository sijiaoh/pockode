import { act, render, screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import MessageList from "../components/Chat/MessageList";
import { useChatMessages } from "../hooks/useChatMessages";
import {
	answerPageRequest,
	chatHistoryRequests,
	resetChatHistoryServer,
} from "./chatHistoryServer";

export interface TranscriptOptions {
	/** The session's history records cut into pages, oldest page first. */
	pages: unknown[][];
	/** The height of the box the transcript fills, in CSS pixels. */
	height?: number;
}

export interface RenderedTranscript {
	/** The element that scrolls. */
	scroller: HTMLElement;
	/** How many older pages the list has asked for so far. */
	requests: () => number;
	/** Scrolls the view as the reader would, and lets the list react. */
	scrollTo: (top: number) => Promise<void>;
	/** Answers the page request in flight, and lets the list react. */
	landPage: () => Promise<void>;
	/**
	 * How far below the view's top edge the element showing `text` sits now —
	 * the number that has to hold still for the reader's content to stay put.
	 */
	viewTopOf: (text: string) => number;
}

const SESSION_ID = "transcript-fixture";

function Transcript() {
	const chat = useChatMessages({ sessionId: SESSION_ID });
	return (
		<MessageList
			sessionId={SESSION_ID}
			messages={chat.messages}
			hasMoreHistory={chat.hasMoreHistory}
			isLoadingMoreHistory={chat.isLoadingMoreHistory}
			historyError={chat.historyError}
			loadedHistoryPages={chat.loadedHistoryPages}
			onLoadMoreHistory={chat.loadMoreHistory}
			tail={chat.tail}
			openedThoughtIds={chat.openedThoughtIds}
		/>
	);
}

function nextFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Lets the browser deliver what a change set off — the scroll event, the
 * resize and intersection observers, which report at the next rendering
 * opportunity — and React commit what those did. Three frames, because each
 * step can only start in the frame after the one before it: the observer
 * reports, its state update commits, the commit's own layout effects ask. One
 * `act` per frame, because React holds every update made inside an `act` until
 * that `act` ends: under a single one, nothing would commit between frames.
 */
async function settle() {
	for (let i = 0; i < 3; i++) await act(nextFrame);
}

/**
 * The chat transcript with real layout, for `*.browser.test.tsx`: the real
 * `MessageList` fed by the real `useChatMessages`, in a box of a fixed height,
 * with only the history RPCs stubbed — the test file installs the stub with the
 * `vi.mock` shown on `stubChatHistoryRpc`.
 *
 * The newest page is what subscribing returns; each older one is asked for by
 * the list itself, as the reader scrolls up, and comes back only when the test
 * lands it. Where the pages are cut is the point: a cut inside an assistant
 * turn is what makes `prependHistoryPage` splice a page into the bubble on
 * screen.
 */
export async function renderTranscript({
	pages,
	height = 600,
}: TranscriptOptions): Promise<RenderedTranscript> {
	resetChatHistoryServer(pages);
	const { container } = render(
		<div className="flex flex-col" style={{ height }}>
			<Transcript />
		</div>,
	);
	// The rows only exist once the subscription's newest page has been applied.
	await waitFor(() =>
		expect(container.querySelector("[data-message-id]")).not.toBeNull(),
	);
	const scroller = container.querySelector<HTMLElement>(".overflow-y-auto");
	if (!scroller) throw new Error("the transcript has no scroll container");
	await settle();

	return {
		scroller,
		requests: chatHistoryRequests,
		scrollTo: async (top) => {
			scroller.scrollTop = top;
			await settle();
		},
		landPage: async () => {
			await act(async () => {
				if (!answerPageRequest()) {
					throw new Error("no page request is in flight");
				}
			});
			await settle();
		},
		viewTopOf: (text) =>
			screen.getByText(text).getBoundingClientRect().top -
			scroller.getBoundingClientRect().top,
	};
}
