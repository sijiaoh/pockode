import { ErrorBoundary } from "@pockode/shared";
import type { ReactNode } from "react";
import { RenderErrorCard } from "../ui";
import PageHeader from "./PageHeader";

interface Props {
	children: ReactNode;
	/** Which page this is; a different one gets drawn afresh. */
	resetKey: unknown;
	/** The failed page's way back to the conversation. */
	onBack: () => void;
}

/**
 * Around a page opened over the chat. What a nearer boundary did not catch
 * costs the page and nothing beside it: the sidebar, the tree and the chat
 * stay, and the heading keeps a way back, since the page's own went with it.
 */
export default function PageErrorBoundary({
	children,
	resetKey,
	onBack,
}: Props) {
	return (
		<ErrorBoundary
			resetKey={resetKey}
			fallback={(error, reset) => (
				<div className="flex flex-1 flex-col overflow-hidden">
					<PageHeader back={{ to: "chat", onClick: onBack }} title="Error" />
					<RenderErrorCard name="this page" error={error} onRetry={reset} />
				</div>
			)}
		>
			{children}
		</ErrorBoundary>
	);
}
