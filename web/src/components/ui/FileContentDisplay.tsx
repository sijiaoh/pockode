import {
	CodeHighlighter,
	getLanguageFromPath,
	isMarkdownFile,
} from "../../lib/shikiUtils";
import { useWSStore } from "../../lib/wsStore";
import { markdownFileBaseDir } from "../../utils/markdownImage";
import { MarkdownContent } from "./MarkdownContent";

interface Props {
	content: string;
	/** Work-directory-relative (Files) or a tool call's native path. */
	filePath?: string;
	/**
	 * Skip both syntax highlighting and Markdown rendering. Markdown is not
	 * exempt from the cost: a megabyte of `.md` builds just as unmanageable a DOM
	 * as a megabyte of source does.
	 */
	plain?: boolean;
	/** See `CodeHighlighter`. */
	copyable?: boolean;
	/** Offered by a rendered `.md` file's images; takes a work-directory-relative path. */
	onOpenFile?: (path: string) => void;
}

export function FileContentDisplay({
	content,
	filePath,
	plain,
	copyable,
	onOpenFile,
}: Props) {
	if (!plain && filePath && isMarkdownFile(filePath)) {
		return (
			<MarkdownFileContent
				content={content}
				filePath={filePath}
				onOpenFile={onOpenFile}
			/>
		);
	}

	const language = filePath ? getLanguageFromPath(filePath) : undefined;
	return (
		<CodeHighlighter language={language} plain={plain} copyable={copyable}>
			{content}
		</CodeHighlighter>
	);
}

function MarkdownFileContent({
	content,
	filePath,
	onOpenFile,
}: {
	content: string;
	filePath: string;
	onOpenFile?: (path: string) => void;
}) {
	const workDir = useWSStore((state) => state.workDir);
	return (
		<MarkdownContent
			content={content}
			baseDir={markdownFileBaseDir(filePath, workDir)}
			onOpenFile={onOpenFile}
		/>
	);
}
