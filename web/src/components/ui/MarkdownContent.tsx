import type { Element } from "hast";
import { type ComponentPropsWithoutRef, lazy, memo, Suspense } from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

// mermaid is a large dependency; load it only when a diagram actually renders
// so it stays out of the main bundle.
const MermaidBlock = lazy(() =>
	import("./MermaidBlock").then((m) => ({ default: m.MermaidBlock })),
);

type CodeProps = ComponentPropsWithoutRef<"code"> & {
	node?: Element;
};

// Only inline code reaches here: a block's <code> is drawn by `MarkdownPre`,
// which never renders its children.
function MarkdownCode({ children }: CodeProps) {
	return (
		<code className="break-all rounded bg-th-code-bg px-1.5 py-0.5 text-sm text-th-code-text">
			{children}
		</code>
	);
}

type PreProps = ComponentPropsWithoutRef<"pre"> & {
	node?: Element;
};

// A block is known by the <pre> around it rather than guessed from its text.
// The <pre> itself is not drawn: `CodeBlock` is the block's box, and a second
// one around it would scroll the header away with the code.
function MarkdownPre({ node, children }: PreProps) {
	const codeNode = node?.children[0];
	if (codeNode?.type !== "element" || codeNode.tagName !== "code") {
		return <pre>{children}</pre>;
	}

	const code = codeNode.children
		.map((child) => (child.type === "text" ? child.value : ""))
		.join("")
		.trimEnd();
	const languageClass = (
		codeNode.properties.className as string[] | undefined
	)?.find((name) => name.startsWith("language-"));
	const language = languageClass?.slice("language-".length);

	if (language === "mermaid") {
		return (
			<div className="markdown-block">
				<Suspense
					fallback={
						<div className="mermaid-placeholder">Loading diagram...</div>
					}
				>
					<MermaidBlock code={code} />
				</Suspense>
			</div>
		);
	}

	return <CodeBlock code={code} language={language} />;
}

type TableProps = ComponentPropsWithoutRef<"table"> & {
	node?: Element;
};

// A table too wide for a phone scrolls in its own box; the transcript around it
// clips sideways rather than scrolling, so without one its right columns would
// be cut off.
function MarkdownTable({ node, ...props }: TableProps) {
	return (
		<div className="markdown-block overflow-x-auto">
			<table {...props} />
		</div>
	);
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
const MARKDOWN_COMPONENTS = {
	code: MarkdownCode,
	pre: MarkdownPre,
	table: MarkdownTable,
	img: MarkdownImage,
};

interface MarkdownContentProps {
	content: string;
	/**
	 * Extra classes for the prose root, for a surface that has to tune it.
	 *
	 * The root carries `min-w-0` itself, so a caller making it a flex item need
	 * not add it. A wide code block or table scrolls in its own box, but that box
	 * still reports its content's full width as its min-content — and a flex
	 * item's `min-width: auto` would floor the item at that width, widening the
	 * row and the page instead of letting the box scroll. That only covers the
	 * root being the flex item: a wrapper that is one, as in `StepList`, needs
	 * `min-w-0` of its own, since a descendant's cannot lower its floor.
	 */
	className?: string;
	/**
	 * `message` is Typography's `prose-sm` tightened for a conversation
	 * (`prose-message`, src/index.css). `note` is commentary rather than a
	 * message: a subagent's words between its steps, drawn at a tool row's size
	 * in secondary colour (`prose-note`, src/index.css) so they cannot be
	 * mistaken for the main agent talking.
	 */
	variant?: "message" | "note";
}

export const MarkdownContent = memo(function MarkdownContent({
	content,
	className,
	variant = "message",
}: MarkdownContentProps) {
	const size = variant === "note" ? "prose-note" : "prose-sm prose-message";
	return (
		<div
			className={`prose dark:prose-invert ${size} max-w-none min-w-0 prose-code:before:content-none prose-code:after:content-none ${className ?? ""}`}
		>
			<Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
				{content}
			</Markdown>
		</div>
	);
});
