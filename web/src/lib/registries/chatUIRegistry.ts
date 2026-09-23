import type { ComponentType } from "react";
import { useSyncExternalStore } from "react";

export interface AvatarProps {
	className?: string;
}

export interface InputBarProps {
	sessionId: string;
	onSend: (content: string) => void;
	/**
	 * The only switch for "can this be sent right now". Typing is never affected
	 * by it — a draft written while the connection is down or history is loading
	 * has to survive the wait. Use `disabled` to close the bar entirely.
	 */
	canSend?: boolean;
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
	 * Offered so a custom bar can *say* something about the open turn.
	 */
	turnOpen?: boolean;
	onStop?: () => void;
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
 * Agent, model and effort are one control: both lists are decided by the agent,
 * and the action bar has no room for a second, wider button.
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
	/** Custom class for assistant bubble */
	assistantBubbleClass?: string;

	/** Custom InputBar component (replaces default) */
	InputBar?: ComponentType<InputBarProps>;

	/** Custom ModeSelector component (set to null to hide) */
	ModeSelector?: ComponentType<ModeSelectorProps> | null;

	/** Custom EngineSelector (agent + model + effort) component (set to null to hide) */
	EngineSelector?: ComponentType<EngineSelectorProps> | null;

	/** Custom StopButton component (set to null to hide) */
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
