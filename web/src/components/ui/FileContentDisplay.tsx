import { useMemo } from "react";
import type { LineMark } from "../../lib/codeRows";
import { readMarkdownFile } from "../../lib/frontmatter";
import {
	CodeHighlighter,
	getLanguageFromPath,
	isMarkdownFile,
} from "../../lib/shikiUtils";
import { useWSStore } from "../../lib/wsStore";
import { markdownFileBaseDir } from "../../utils/markdownImage";
import { FrontmatterBlock } from "./FrontmatterBlock";
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
	/** Draw a Markdown file as its source, still highlighted, instead of rendering it. */
	source?: boolean;
	/** See `CodeHighlighter`. */
	copyable?: boolean;
	/** See `CodeHighlighter`; a rendered `.md` file has no lines to number. */
	lineNumbers?: boolean;
	/** See `CodeHighlighter`; only where `lineNumbers` is set. */
	mark?: LineMark | null;
	onMarkEnd?: () => void;
	/** Offered by a rendered `.md` file's images; takes a work-directory-relative path. */
	onOpenFile?: (path: string) => void;
}

export function FileContentDisplay({
	content,
	filePath,
	plain,
	source,
	copyable,
	lineNumbers = false,
	mark,
	onMarkEnd,
	onOpenFile,
}: Props) {
	if (filePath && rendersMarkdown(filePath, plain || source)) {
		return (
			<MarkdownFileContent
				content={content}
				filePath={filePath}
				onOpenFile={onOpenFile}
			/>
		);
	}

	const language = filePath ? getLanguageFromPath(filePath) : undefined;
	return lineNumbers ? (
		<CodeHighlighter
			language={language}
			plain={plain}
			copyable={copyable}
			lineNumbers
			mark={mark}
			onMarkEnd={onMarkEnd}
		>
			{content}
		</CodeHighlighter>
	) : (
		<CodeHighlighter language={language} plain={plain} copyable={copyable}>
			{content}
		</CodeHighlighter>
	);
}

/** Whether `FileContentDisplay` draws the file as Markdown rather than as text. */
export function rendersMarkdown(filePath: string, plain?: boolean): boolean {
	return !plain && isMarkdownFile(filePath);
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
	const { frontmatter, body } = useMemo(
		() => readMarkdownFile(content),
		[content],
	);
	const markdown = (
		<MarkdownContent
			content={body}
			baseDir={markdownFileBaseDir(filePath, workDir)}
			onOpenFile={onOpenFile}
		/>
	);
	if (!frontmatter) return markdown;
	return (
		<div className="space-y-4">
			<FrontmatterBlock frontmatter={frontmatter} />
			{body.trim() && markdown}
		</div>
	);
}
