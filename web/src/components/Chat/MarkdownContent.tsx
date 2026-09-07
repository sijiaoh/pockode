import type { Element } from "hast";
import { type ComponentPropsWithoutRef, lazy, memo, Suspense } from "react";
import Markdown from "react-markdown";
import { isInlineCode } from "react-shiki";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { CodeHighlighter } from "../../lib/shikiUtils";

// mermaid is a large dependency; load it only when a diagram actually renders
// so it stays out of the main bundle.
const MermaidBlock = lazy(() =>
	import("./MermaidBlock").then((m) => ({ default: m.MermaidBlock })),
);

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
		return (
			<Suspense
				fallback={
					<div className="flex items-center justify-center p-4 text-th-text-muted">
						Loading diagram...
					</div>
				}
			>
				<MermaidBlock code={code} />
			</Suspense>
		);
	}

	return <CodeHighlighter language={language}>{code}</CodeHighlighter>;
}

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const MARKDOWN_COMPONENTS = { code: CodeBlock };

interface MarkdownContentProps {
	content: string;
}

export const MarkdownContent = memo(function MarkdownContent({
	content,
}: MarkdownContentProps) {
	return (
		<div className="prose dark:prose-invert prose-sm max-w-none prose-code:before:content-none prose-code:after:content-none prose-pre:bg-transparent prose-pre:p-0 prose-pre:text-[length:inherit]">
			<Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
				{content}
			</Markdown>
		</div>
	);
});
