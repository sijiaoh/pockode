import type { Element, ElementContent } from "hast";
import {
	type ComponentPropsWithoutRef,
	type CSSProperties,
	lazy,
	memo,
	type ReactNode,
	Suspense,
	useEffect,
	useRef,
	useState,
} from "react";
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

/**
 * A soft break after each run of `/` that has something after it, so a path too
 * long for the line breaks between its segments rather than mid-name — and a
 * URL's `//` stays in one piece.
 */
function breakAfterSlashes(children: ReactNode): ReactNode {
	if (typeof children !== "string") return children;
	const segments = children.match(/[^/]*\/+|[^/]+$/g);
	if (!segments || segments.length < 2) return children;
	return segments.flatMap((segment, i) =>
		// biome-ignore lint/suspicious/noArrayIndexKey: the segments of one fixed string
		i === 0 ? [segment] : [<wbr key={i} />, segment],
	);
}

// Only inline code reaches here: a block's <code> is drawn by `MarkdownPre`,
// which never renders its children.
//
// An inline-block capped at the line, so a token that fits on a line of its own
// moves there whole and only one longer than the line breaks inside — at a `/`
// where it has one, anywhere as the last resort. Its baseline is its first
// line's, so the text beside a token that did break lines up with its start
// rather than its end. In em and at the text's weight, so it follows a table
// cell's or a note's smaller text and does not outweigh bold: the ground and
// the mono face already set it apart.
function MarkdownCode({ children }: CodeProps) {
	return (
		<code className="inline-block max-w-full rounded bg-th-code-bg px-1 align-baseline font-normal [baseline-source:first] text-[0.9em] text-th-code-text leading-snug [overflow-wrap:anywhere]">
			{breakAfterSlashes(children)}
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
// be cut off. The right edge fades while there is more to the right, since a box
// that scrolls sideways says so nowhere else on a touch screen.
function MarkdownTable({ node, ...props }: TableProps) {
	const ref = useRef<HTMLDivElement>(null);
	const [moreRight, setMoreRight] = useState(false);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const check = () =>
			setMoreRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
		check();
		el.addEventListener("scroll", check, { passive: true });
		const observer = new ResizeObserver(check);
		observer.observe(el);
		if (el.firstElementChild) observer.observe(el.firstElementChild);
		return () => {
			el.removeEventListener("scroll", check);
			observer.disconnect();
		};
	}, []);

	return (
		<div
			ref={ref}
			className={`markdown-block overflow-x-auto ${moreRight ? "[mask-image:linear-gradient(to_left,transparent,black_2rem)]" : ""}`}
		>
			<table {...props} />
		</div>
	);
}

type HeaderCellProps = ComponentPropsWithoutRef<"th"> & {
	node?: Element;
};

function textOf(node: Element | ElementContent): string {
	if (node.type === "text") return node.value;
	if (node.type !== "element") return "";
	return node.children.map(textOf).join("");
}

// The header row is where a column's width floor is set, since every GFM table
// has one. A floor of its own, so a column of prose is not squeezed to its
// longest word, one word to a line; and at least wide enough for the header's
// text in about two lines, so a long header widens its column — the table
// scrolls — instead of standing four lines tall over a column of short cells.
// `ch` is a digit's width; prose averages a little more per character, which
// the factor takes up.
function MarkdownHeaderCell({
	node,
	style,
	className,
	...props
}: HeaderCellProps) {
	const length = node ? textOf(node).trim().length : 0;
	return (
		<th
			{...props}
			style={
				{
					...style,
					"--header-width": `${Math.ceil(length * 0.6)}ch`,
				} as CSSProperties
			}
			className={`min-w-[max(9em,var(--header-width))] ${className ?? ""}`}
		/>
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
	th: MarkdownHeaderCell,
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
