import { CodeHighlighter } from "../../lib/shikiUtils";
import { BlockHeader, HeaderCopyButton } from "./BlockHeader";

/**
 * A fenced code block in prose: a header bar naming the language and holding
 * the copy button, over code that scrolls sideways in its own box.
 *
 * Its own scroll box rather than an ancestor's, because the ancestor here is the
 * transcript, which clips sideways instead of scrolling — and the header stays
 * put while the code scrolls under it. `not-prose` because Typography would
 * otherwise style shiki's inner <pre> as a second code block.
 */
export function CodeBlock({
	code,
	language,
}: {
	code: string;
	language?: string;
}) {
	return (
		<div className="markdown-block markdown-code not-prose">
			<div className="border-b border-th-border px-4 py-0.5 font-mono text-xs">
				<BlockHeader
					label={<span className="truncate">{language}</span>}
					actions={<HeaderCopyButton text={code} label="Copy code" />}
				/>
			</div>
			<div className="overflow-x-auto">
				<CodeHighlighter language={language} copyable={false}>
					{code}
				</CodeHighlighter>
			</div>
		</div>
	);
}
