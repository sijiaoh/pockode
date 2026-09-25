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
				fallback={<div className="mermaid-placeholder">Loading diagram...</div>}
			>
				<MermaidBlock code={code} />
			</Suspense>
		);
	}

	return <CodeHighlighter language={language}>{code}</CodeHighlighter>;
}

type ImageProps = ComponentPropsWithoutRef<"img"> & {
	node?: Element;
};

// `node` is react-markdown's hast node and must not reach the DOM.
function MarkdownImage({ node, alt, ...props }: ImageProps) {
	return (
		<span className="markdown-image">
			<img alt={alt ?? ""} {...props} />
		</span>
	);
}

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const MARKDOWN_COMPONENTS = { code: CodeBlock, img: MarkdownImage };

interface MarkdownContentProps {
	content: string;
	/**
	 * Extra classes for the prose root, for a surface that has to tune it.
	 *
	 * A caller that makes this a flex item has to include `min-w-0`, or wrap it in
	 * an element that has it the way `StepList` does. A wide code block here is
	 * meant to be scrolled by an ancestor scroll container rather than by its own
	 * box, so `.code-block` sets `min-width: fit-content` (`web/src/index.css`) —
	 * and a flex item's `min-width: auto` then floors the item at that full width,
	 * widening the row and the page instead of letting the ancestor scroll.
	 */
	className?: string;
}

export const MarkdownContent = memo(function MarkdownContent({
	content,
	className,
}: MarkdownContentProps) {
	return (
		<div
			className={`prose dark:prose-invert prose-sm max-w-none prose-code:before:content-none prose-code:after:content-none prose-pre:bg-transparent prose-pre:p-0 prose-pre:text-[length:inherit] ${className ?? ""}`}
		>
			<Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
				{content}
			</Markdown>
		</div>
	);
});
