import { Ban, Check, EyeOff, Undo2 } from "lucide-react";
import { useContext, useId, useState } from "react";
import { useComposerDraft } from "../../hooks/useComposerDraft";
import type { UserMessage } from "../../types/message";
import {
	commandRestoreBlocked,
	type Draft,
	isInDraft,
	turnRestore,
} from "../../utils/discardedMessage";
import MenuRow from "../common/MenuRow";
import { DiscardedMessagesContext } from "./discardedMessagesContext";

/**
 * The ending, drawn on the message itself, after everything it carried. Part of
 * the message's text, so a screen reader reads it right after the content. The
 * colour is the host's: inside the user's bubble it is the bubble's own text
 * colour, which `contrast.test.ts` already holds against the bubble.
 */
export function DiscardedNote({ className = "" }: { className?: string }) {
	return (
		<p className={`flex items-center gap-1.5 text-xs ${className}`}>
			<EyeOff className="size-3.5 shrink-0" aria-hidden="true" />
			Not read — won't be answered
		</p>
	);
}

const restoreButtonClass =
	"inline-flex min-h-9 shrink-0 items-center gap-1 rounded-lg px-3 text-th-accent hover:bg-th-overlay-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent pointer-coarse:min-h-11";

interface SummaryProps {
	ids: readonly string[];
	sessionId: string;
	/** Absent where there is no composer to restore into. */
	onRestore?: (messages: UserMessage[]) => void;
}

/**
 * What the Stop that ended this turn did, under its `Interrupted`, and the
 * main way back: the user pressed Stop to have the agent take a message they
 * had just sent, so this is where they are looking (docs/discarded-messages-ui.md).
 */
export function DiscardedSummary({ ids, sessionId, onRestore }: SummaryProps) {
	const { discarded, hasMoreHistory } = useContext(DiscardedMessagesContext);
	const draft = useComposerDraft(sessionId);
	const countId = useId();
	// The draft a blocked press was refused against: the reason stays up while
	// that draft does, and does not come back by itself for a later one.
	const [refusedDraft, setRefusedDraft] = useState<Draft | null>(null);
	const { messages, leavesCommands, notLoaded } = turnRestore(ids, discarded);

	const count = ids.length;
	const canRestore = onRestore !== undefined && messages.length > 0;
	const inInput =
		canRestore && messages.every((message) => isInDraft(message, draft));
	// Only ever the lone command: a press that restores several never takes one.
	const blocked =
		messages.length === 1
			? commandRestoreBlocked(messages[0], draft)
			: undefined;

	return (
		<div className="mt-1 text-sm text-th-text-secondary">
			<div className="flex flex-wrap items-center justify-between gap-x-2">
				<p id={countId} className="flex min-w-0 items-center gap-1.5 py-1">
					<Ban className="size-4 shrink-0 text-th-warning" aria-hidden="true" />
					{count === 1
						? "1 unread message was discarded."
						: `${count} unread messages were discarded.`}
				</p>
				{canRestore && (
					<button
						type="button"
						onClick={() => {
							if (blocked) {
								setRefusedDraft(draft);
								return;
							}
							onRestore(messages);
						}}
						aria-disabled={blocked ? true : undefined}
						// Named by what it says, so a voice user can say what they see;
						// how many it restores is the line it belongs to.
						aria-describedby={countId}
						className={`ml-auto ${restoreButtonClass}`}
					>
						{inInput && <Check className="size-4" aria-hidden="true" />}
						{inInput ? "In input" : "Restore to input"}
					</button>
				)}
			</div>
			{canRestore && blocked && refusedDraft === draft && (
				<p className="text-xs text-th-text-muted">{blocked}</p>
			)}
			{onRestore && leavesCommands && (
				<p className="text-xs text-th-text-muted">
					Commands are restored one at a time from their message's … menu.
				</p>
			)}
			{/* Only while there is earlier history to load: otherwise the message
			    is one this tab sent and has not heard back about yet, and the
			    reply naming it is on its way. */}
			{onRestore && notLoaded > 0 && hasMoreHistory && (
				<p className="text-xs text-th-text-muted">
					{notLoaded === 1
						? "One is in earlier history. Scroll up to load it."
						: `${notLoaded} are in earlier history. Scroll up to load them.`}
				</p>
			)}
		</div>
	);
}

interface RestoreRowProps {
	message: UserMessage;
	sessionId: string;
	onRestore: (messages: UserMessage[]) => void;
	onClose: () => void;
}

/**
 * The menu's way back for one message: the one a summary leaves to it (a
 * command among others), or a message long scrolled past its turn's end.
 */
export function RestoreMenuRow({
	message,
	sessionId,
	onRestore,
	onClose,
}: RestoreRowProps) {
	const draft = useComposerDraft(sessionId);
	const inInput = isInDraft(message, draft);
	const blocked = commandRestoreBlocked(message, draft);
	return (
		<MenuRow
			icon={inInput ? Check : Undo2}
			label={inInput ? "In input" : "Restore to input"}
			description={blocked}
			disabled={blocked !== undefined}
			onClick={() => {
				onClose();
				onRestore([message]);
			}}
		/>
	);
}
