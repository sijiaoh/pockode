import {
	CodeHighlighter,
	getLanguageFromPath,
	isMarkdownFile,
} from "../../lib/shikiUtils";
import { MarkdownContent } from "../Chat/MarkdownContent";

interface Props {
	content: string;
	filePath?: string;
	showRaw?: boolean;
}

export function FileContentDisplay({ content, filePath, showRaw }: Props) {
	if (filePath && isMarkdownFile(filePath) && !showRaw) {
		return <MarkdownContent content={content} />;
	}

	const language = filePath ? getLanguageFromPath(filePath) : undefined;
	return <CodeHighlighter language={language}>{content}</CodeHighlighter>;
}
