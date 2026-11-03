import { Code } from "lucide-react";
import { isMarkdownFile } from "../../lib/shikiUtils";
import type { FileViewState } from "../../utils/fileView";
import ToggleIconButton from "./ToggleIconButton";

/** What a source can be the source of, which names the way back to it. */
export type SourceRendering = "markdown" | "page";

/**
 * Which rendering a file has to switch away from, or null where Source would
 * change nothing. A page has one at any size; Markdown past `HIGHLIGHT_LIMIT`
 * is already drawn as its source, with a banner saying so.
 */
export function sourceRenderingOf(
	state: FileViewState | null,
	path: string,
): SourceRendering | null {
	if (state?.kind === "page") return "page";
	if (state?.kind === "text" && state.highlight && isMarkdownFile(path))
		return "markdown";
	return null;
}

interface Props {
	rendering: SourceRendering;
	showingSource: boolean;
	onToggle: () => void;
}

/** The toolbar's switch between a file's rendering and its source. */
function SourceToggle({ rendering, showingSource, onToggle }: Props) {
	return (
		<ToggleIconButton
			icon={Code}
			pressed={showingSource}
			onClick={onToggle}
			label={
				showingSource
					? rendering === "page"
						? "Show page"
						: "Show rendered"
					: "Show source"
			}
		/>
	);
}

export default SourceToggle;
