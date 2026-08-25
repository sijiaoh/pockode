import {
	CodeHighlighter,
	getLanguageFromPath,
	isMarkdownFile,
} from "../../lib/shikiUtils";
import { MarkdownContent } from "../Chat/MarkdownContent";

interface Props {
	content: string;
	filePath?: string;
	/**
	 * Skip both syntax highlighting and Markdown rendering. Markdown is not
	 * exempt from the cost: a megabyte of `.md` builds just as unmanageable a DOM
	 * as a megabyte of source does.
	 */
	plain?: boolean;
}

export function FileContentDisplay({ content, filePath, plain }: Props) {
	if (!plain && filePath && isMarkdownFile(filePath)) {
		return <MarkdownContent content={content} />;
	}

	const language = filePath ? getLanguageFromPath(filePath) : undefined;
	return (
		<CodeHighlighter language={language} plain={plain}>
			{content}
		</CodeHighlighter>
	);
}
