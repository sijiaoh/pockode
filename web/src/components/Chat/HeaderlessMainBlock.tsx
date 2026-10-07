import { type ReactNode, useRef, useState } from "react";
import type { FullScreenSource } from "../../lib/fullScreen";
import { ClampedContent, type ClampView } from "../ui";
import { useFullScreen } from "./FullScreenHost";
import { ContentSlice, hugeClamp, useHugeContent } from "./HugeContent";

/**
 * A main block with no header to carry its Full screen button — a plan, a
 * subagent's report — which carries it in its clamp's button row instead, or
 * for huge content the one button that opens it.
 */
export function HeaderlessMainBlock({
	name,
	fullScreenKey,
	source,
	view,
	children,
}: {
	/** What the block is, lowercased: "plan". */
	name: string;
	/** Names the block across remounts; see `FullScreenHost`. */
	fullScreenKey: string;
	source: FullScreenSource | undefined;
	view: ClampView | null;
	children: ReactNode;
}) {
	const rootRef = useRef<HTMLDivElement>(null);
	const [opened, setOpened] = useState(false);
	const open = useFullScreen(fullScreenKey, source);
	const { pending, huge } = useHugeContent({
		content: source?.content,
		from: source?.from ?? "start",
		noun: name,
		rootRef,
		openedInPlace: opened,
		enabled: open !== null,
	});

	return (
		<div ref={rootRef}>
			{!pending && (
				<ClampedContent
					budget="main"
					name={name}
					view={view}
					onOpenChange={setOpened}
					fullScreen={open ? { key: fullScreenKey, open } : undefined}
					huge={hugeClamp(huge, fullScreenKey, open)}
				>
					{huge ? <ContentSlice content={huge.slice} /> : children}
				</ClampedContent>
			)}
		</div>
	);
}
