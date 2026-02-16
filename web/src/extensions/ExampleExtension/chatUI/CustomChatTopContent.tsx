import type { ChatTopContentProps } from "../../../lib/registries/chatUIRegistry";

export default function CustomChatTopContent({
	sessionId: _sessionId,
}: ChatTopContentProps) {
	return (
		<div className="border-b border-th-border bg-th-bg-secondary px-4 py-2 text-center text-xs th-text-muted">
			Custom Chat Header - Powered by Extension
		</div>
	);
}
