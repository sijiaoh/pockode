import { useEffect, useId, useRef, useState } from "react";
import { AGENT_TYPE_INFO } from "../../lib/agentType";
import type { Message } from "../../types/message";
import type { AgentType } from "../../types/settings";
import { messagePreview } from "../../utils/messagePreview";
import { Sheet, Spinner } from "../ui";

interface Props {
	/** The message the user picked the fork out of. */
	anchor: Message;
	/** How many messages stay behind, the anchor included when it is dropped. */
	droppedCount: number;
	agentType: AgentType;
	defaultTitle: string;
	isForking: boolean;
	/** The server's refusal, verbatim; the sheet stays open showing it. */
	error: string | null;
	onFork: (title: string) => void;
	onClose: () => void;
}

/**
 * What the fork keeps and what it leaves, in the two shapes the rule takes.
 *
 * A fork returns to the moment before the anchor happened. For an agent message
 * that moment is after it was said, so the new session keeps it; for a message
 * the user sent it is before they said it, so the new session never shows it
 * and the user is about to say it again. Same rule, two sentences, because
 * "up to this message" would be a lie in the second case.
 */
function keptSentence(
	anchorRole: Message["role"],
	droppedCount: number,
): string {
	if (anchorRole === "user") {
		const kept =
			"The new session keeps the conversation up to just before this message.";
		// The anchor itself is always one of them, so there is no zero case.
		if (droppedCount === 1) {
			return `${kept} This message stays in this session.`;
		}
		if (droppedCount === 2) {
			return `${kept} This message and the one after it stay in this session.`;
		}
		return `${kept} This message and the ${droppedCount - 1} after it stay in this session.`;
	}

	const kept = "The new session keeps the conversation up to this message.";
	if (droppedCount === 0) return kept;
	if (droppedCount === 1) {
		return `${kept} The message after it stays in this session.`;
	}
	return `${kept} The ${droppedCount} messages after it stay in this session.`;
}

/**
 * Confirms a fork: what it keeps, what it leaves behind, and what to call it.
 *
 * It says nothing about whether the agent will remember the conversation: an
 * agent that cannot reopen one is refused before this sheet opens, and for one
 * that can, the only remaining reasons a fork carries nothing are server-side
 * facts no client can see. The notice the fork writes into the new transcript is
 * the statement of those.
 *
 * The anchor is echoed back because the user picked it out of a scrolling
 * transcript on a phone, and seeing it is the only way to confirm they hit the
 * right one. Whether it is the last message the fork keeps or the first one it
 * leaves behind is what the sentence under it says.
 */
function ForkSessionSheet({
	anchor,
	droppedCount,
	agentType,
	defaultTitle,
	isForking,
	error,
	onFork,
	onClose,
}: Props) {
	const [title, setTitle] = useState(defaultTitle);
	const inputRef = useRef<HTMLInputElement>(null);
	const inputId = useId();

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const agentLabel = AGENT_TYPE_INFO[agentType].label;
	const preview = messagePreview(anchor);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = title.trim();
		if (!trimmed || isForking) return;
		onFork(trimmed);
	};

	return (
		<Sheet
			title="Fork session"
			onClose={onClose}
			// A slow relay link must not leave the user able to dismiss the sheet
			// and be left unsure whether a session was created.
			dismissible={!isForking}
			onSubmit={handleSubmit}
			footer={
				<>
					<button
						type="button"
						onClick={onClose}
						disabled={isForking}
						className="flex-1 rounded-lg bg-th-bg-tertiary px-4 py-2.5 text-sm text-th-text-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={!title.trim() || isForking}
						className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-th-accent px-4 py-2.5 text-sm text-th-accent-text transition-colors hover:bg-th-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
					>
						{/* The gerund label already announces the state; the spinner's
						    own "Loading" would only say it twice. */}
						{isForking && <Spinner variant="current" srText={null} />}
						{isForking ? "Forking…" : "Fork"}
					</button>
				</>
			}
		>
			<div className="space-y-4 p-4">
				{/* Above the field, like the app's other sheets: pushed below it the
				    refusal would sit under the on-screen keyboard on a phone. */}
				{error && (
					<p className="whitespace-pre-wrap text-sm text-th-error" role="alert">
						{error}
					</p>
				)}

				<div className="rounded-lg border-l-2 border-th-border bg-th-bg-tertiary px-3 py-2">
					<div className="text-xs text-th-text-muted">
						{anchor.role === "user" ? "You" : agentLabel}
					</div>
					<p className="line-clamp-3 text-sm text-th-text-secondary">
						{preview}
					</p>
				</div>

				<p className="text-sm text-th-text-secondary">
					{keptSentence(anchor.role, droppedCount)}
				</p>

				<div className="space-y-1.5">
					<label htmlFor={inputId} className="text-sm text-th-text-primary">
						Title
					</label>
					<input
						ref={inputRef}
						id={inputId}
						type="text"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						className="w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2.5 text-th-text-primary placeholder:text-th-text-muted focus:border-th-border-focus focus:outline-none focus:ring-2 focus:ring-th-accent/20"
						disabled={isForking}
						autoComplete="off"
						required
					/>
				</div>
			</div>
		</Sheet>
	);
}

export default ForkSessionSheet;
