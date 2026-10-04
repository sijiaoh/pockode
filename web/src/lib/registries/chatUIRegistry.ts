import type { ComponentType } from "react";
import { useSyncExternalStore } from "react";
import type { ChatAttachment } from "../chatAttachments";

export interface AvatarProps {
	className?: string;
}

/**
 * A bar is unmounted, not merely hidden, whenever the host has to give its row
 * to something else: the work and agent-role overlays replace everything in the
 * chat pane but the transcript, which they cover instead, and on a short
 * viewport the answer panel folds the bar away while the user answers
 * (docs/answering-ui.md §3). A draft the user has already typed
 * has to outlive that, so it cannot live in the bar's own state alone — the
 * default bar keeps it in `inputStore`, keyed by session, files and their
 * uploads included.
 */
/**
 * What became of a send, as far as the bar has to act on it. `refused`: the
 * server turned the message down whole — nothing was written or delivered, and
 * the host has said why and put the text back — so whatever else the bar took
 * out of the draft for it (the default bar's files) goes back too. `sent`
 * covers everything else, a failed delivery included: that message stands in
 * the transcript with its failure under it, and may have reached the agent.
 */
export type SendOutcome = "sent" | "refused";

export interface InputBarProps {
	sessionId: string;
	/**
	 * `content` may be empty when `attachments` is not. The attachments are
	 * files already in the session's store (`uploadChatAttachment`).
	 */
	onSend: (
		content: string,
		attachments?: ChatAttachment[],
	) => Promise<SendOutcome>;
	/**
	 * The only switch for "can this be sent right now". Typing is never affected
	 * by it — a draft written while the connection is down or history is loading
	 * has to survive the wait. Use `disabled` to close the bar entirely.
	 */
	canSend?: boolean;
	/**
	 * Why the host refuses sends, when the reason is one the user has to act
	 * on — today a permission request owning the agent's next input. Only
	 * meaningful while `canSend` is false; absent for refusals that pass on
	 * their own (a dropped connection, history loading). The default bar shows
	 * it as the placeholder, since nothing else on screen says why Send is gone.
	 */
	sendBlockedReason?: string;
	disabled?: boolean;
	/**
	 * Whether a turn is open — running, or blocked on something only the user or
	 * the agent's own background work can clear.
	 *
	 * Not a reason to refuse a send: a message sent mid-reply steers the running
	 * turn, and is answered inside it from the point the agent reads it — in a
	 * bubble of its own, not the one already being written
	 * (docs/lifecycle-ui.md §2.3). The one state that does refuse — a permission or
	 * question request owning the agent's next line of input — reaches the bar as
	 * `canSend={false}`, already decided by the host. A bar that refuses on
	 * `turnOpen` is refusing sends the server would have accepted.
	 *
	 * What it does decide is Stop, which is the bar's: the host draws no Stop of
	 * its own. The default bar gives Send and Stop one slot, never both at once —
	 * Stop while the turn is open and Send has nothing to do (no draft, or
	 * `canSend={false}`), and held unpressable for a moment after it arrives,
	 * since it lands under the thumb that just pressed Send. `slotShowsStop` and
	 * `Armed` in `Chat/SendStopSlot.tsx` are that rule, for a custom bar to
	 * reuse. A custom bar that draws no Stop leaves the user no way to interrupt
	 * on a touch screen.
	 */
	turnOpen?: boolean;
	/** Interrupts the open turn. */
	onStop?: () => void;
	/**
	 * Bumped when the host has just put something into the draft for the user
	 * to go on from (a failed turn's message, back after signing in). Answered
	 * like a session change: focus where a physical keyboard is likely, nothing
	 * where focusing would raise an on-screen keyboard over the conversation.
	 */
	focusRequest?: number;
}

export interface ModeSelectorProps {
	mode: "default" | "yolo";
	agentType: "claude" | "codex";
	onModeChange: (mode: "default" | "yolo") => Promise<void>;
	/**
	 * False while the session has yet to describe itself, so `mode` and
	 * `agentType` are placeholders with no value to show — the same flag
	 * `EngineSelectorProps` carries, for the same round trip.
	 */
	hasSessionSettings?: boolean;
	disabled?: boolean;
}

/**
 * Agent, model and effort are one control: both lists are decided by the agent.
 */
export interface EngineSelectorProps {
	agentType: "claude" | "codex";
	/** Empty means "let the CLI pick". */
	model: string;
	/** Empty means "let the CLI keep its own default". */
	effort: string;
	onAgentTypeChange: (type: "claude" | "codex") => Promise<void>;
	onModelChange: (model: string) => Promise<void>;
	onEffortChange: (effort: string) => Promise<void>;
	/**
	 * False while the session has yet to describe itself, so `agentType`, `model`
	 * and `effort` are placeholders with no value to show.
	 */
	hasSessionSettings?: boolean;
	isSessionActivated?: boolean;
	disabled?: boolean;
}

export interface StopButtonProps {
	onStop: () => void;
}

export interface EmptyStateProps {
	onHintClick?: (hint: string) => void;
}

export interface ChatTopContentProps {
	sessionId: string;
}

export interface ChatUIConfig {
	/** Custom component for user avatar */
	UserAvatar?: ComponentType<AvatarProps>;
	/** Custom component for assistant avatar */
	AssistantAvatar?: ComponentType<AvatarProps>;
	/** Custom class for user bubble */
	userBubbleClass?: string;
	/** Custom class for the assistant's content column (it has no bubble) */
	assistantBubbleClass?: string;

	/** Custom InputBar component (replaces default) */
	InputBar?: ComponentType<InputBarProps>;

	/**
	 * Custom ModeSelector, drawn as the Permissions section of the session panel
	 * the header's title opens (set to null to drop the section).
	 */
	ModeSelector?: ComponentType<ModeSelectorProps> | null;

	/**
	 * Custom EngineSelector (agent + model + effort), drawn as the Engine
	 * section of the session panel the header's title opens (set to null to drop
	 * the section).
	 */
	EngineSelector?: ComponentType<EngineSelectorProps> | null;

	/**
	 * Custom StopButton, drawn by the default InputBar in its send slot in place
	 * of the built-in Stop, and armed the same way (set to null to hide: the
	 * slot then only ever holds Send). A custom InputBar draws its own Stop.
	 */
	StopButton?: ComponentType<StopButtonProps> | null;

	/** Custom EmptyState component (shown when there are no messages) */
	EmptyState?: ComponentType<EmptyStateProps>;

	/** Custom component shown above the message list */
	ChatTopContent?: ComponentType<ChatTopContentProps>;
}

const defaultConfig: ChatUIConfig = {};

let config: ChatUIConfig = { ...defaultConfig };
const listeners = new Set<() => void>();

function notifyListeners(): void {
	for (const listener of listeners) {
		listener();
	}
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function getSnapshot(): ChatUIConfig {
	return config;
}

/**
 * @internal Use `ctx.chatUI.configure()` from extension context instead.
 */
export function setChatUIConfig(newConfig: Partial<ChatUIConfig>): void {
	config = { ...config, ...newConfig };
	notifyListeners();
}

export function useChatUIConfig(): ChatUIConfig {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * @internal For testing only.
 */
export function getChatUIConfig(): ChatUIConfig {
	return config;
}

/**
 * @internal For testing only.
 */
export function resetChatUIConfig(): void {
	config = { ...defaultConfig };
	notifyListeners();
}
