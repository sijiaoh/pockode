import type { Element } from "hast";
import type { ComponentPropsWithoutRef } from "react";
import Markdown from "react-markdown";
import { isInlineCode } from "react-shiki";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { CodeHighlighter } from "../../lib/shikiUtils";
import { MermaidBlock } from "./MermaidBlock";

type CodeProps = ComponentPropsWithoutRef<"code"> & {
	node?: Element;
};

function CodeBlock({ className, children, node }: CodeProps) {
	const code = String(children).trimEnd();
	const match = className?.match(/language-(\w+)/);
	const language = match ? match[1] : undefined;
	const isInline = node ? isInlineCode(node) : !language;

	if (isInline) {
		return (
			<code className="break-all rounded bg-th-code-bg px-1.5 py-0.5 text-sm text-th-code-text">
				{children}
			</code>
		);
	}

	if (language === "mermaid") {
		return <MermaidBlock code={code} />;
	}

	return <CodeHighlighter language={language}>{code}</CodeHighlighter>;
}

interface MarkdownContentProps {
	content: string;
}

export function MarkdownContent({ content }: MarkdownContentProps) {
	return (
		<div className="prose dark:prose-invert prose-sm max-w-none prose-code:before:content-none prose-code:after:content-none prose-pre:bg-transparent prose-pre:p-0 prose-pre:text-[length:inherit]">
			<Markdown
				remarkPlugins={[remarkGfm, remarkBreaks]}
				components={{
					code: CodeBlock,
				}}
			>
				{content}
			</Markdown>
		</div>
	);
}
