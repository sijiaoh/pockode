import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view-pure.css";
import type { getDiffViewHighlighter } from "@git-diff-view/shiki";
import { useIsDesktop } from "@pockode/shared";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
	CODE_FONT_SIZE_DESKTOP,
	CODE_FONT_SIZE_MOBILE,
	getDiffHighlighter,
	getIsDarkMode,
	subscribeToDarkMode,
} from "../../lib/shikiUtils";

interface DiffViewerProps {
	fileName: string;
	hunks: string[];
	oldContent?: string;
	newContent?: string;
}

export function DiffViewer({
	fileName,
	hunks,
	oldContent,
	newContent,
}: DiffViewerProps) {
	const isDark = useSyncExternalStore(subscribeToDarkMode, getIsDarkMode);
	const isDesktop = useIsDesktop();
	const [highlighter, setHighlighter] = useState<Awaited<
		ReturnType<typeof getDiffViewHighlighter>
	> | null>(null);

	useEffect(() => {
		getDiffHighlighter().then(setHighlighter);
	}, []);

	if (!highlighter) {
		return <div className="p-2 text-th-text-muted">Loading...</div>;
	}

	return (
		<div className="diff-view-wrapper diff-tailwindcss-wrapper">
			<DiffView
				data={{
					oldFile: { fileName, content: oldContent },
					newFile: { fileName, content: newContent },
					hunks,
				}}
				registerHighlighter={highlighter}
				diffViewMode={DiffModeEnum.Unified}
				diffViewTheme={isDark ? "dark" : "light"}
				diffViewHighlight
				diffViewFontSize={
					isDesktop ? CODE_FONT_SIZE_DESKTOP : CODE_FONT_SIZE_MOBILE
				}
			/>
		</div>
	);
}
