import type { ComponentType } from "react";
import { useSyncExternalStore } from "react";

export interface AvatarProps {
	className?: string;
}

export interface InputBarProps {
	sessionId: string;
	onSend: (content: string) => void;
	canSend?: boolean;
	isStreaming?: boolean;
	onStop?: () => void;
}

export interface ModeSelectorProps {
	mode: "default" | "yolo";
	onModeChange: (mode: "default" | "yolo") => Promise<void>;
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
	/** Max width for chat messages (CSS value) */
	maxWidth?: string;
	/** Custom class for user bubble */
	userBubbleClass?: string;
	/** Custom class for assistant bubble */
	assistantBubbleClass?: string;

	// InputBar slot - replaces entire InputBar component
	/** Custom InputBar component (replaces default) */
	InputBar?: ComponentType<InputBarProps>;

	// ModeSelector slot - set to null to hide, or provide custom component
	/** Custom ModeSelector component (set to null to hide) */
	ModeSelector?: ComponentType<ModeSelectorProps> | null;

	// StopButton slot - set to null to hide, or provide custom component
	/** Custom StopButton component (set to null to hide) */
	StopButton?: ComponentType<StopButtonProps> | null;

	// EmptyState slot - replaces the empty message list state
	/** Custom EmptyState component (shown when there are no messages) */
	EmptyState?: ComponentType<EmptyStateProps>;

	// ChatTopContent slot - shown above message list (always visible)
	/** Custom component shown above the message list */
	ChatTopContent?: ComponentType<ChatTopContentProps>;
}

const defaultConfig: ChatUIConfig = {};

let config: ChatUIConfig = { ...defaultConfig };
const listeners = new Set<() => void>();

function emit(): void {
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

export function setChatUIConfig(newConfig: Partial<ChatUIConfig>): void {
	config = { ...config, ...newConfig };
	emit();
}

export function useChatUIConfig(): ChatUIConfig {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getChatUIConfig(): ChatUIConfig {
	return config;
}

export function resetChatUIConfig(): void {
	config = { ...defaultConfig };
	emit();
}
