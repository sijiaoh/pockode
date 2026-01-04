import mermaid from "mermaid";
import { useId, useLayoutEffect, useState, useSyncExternalStore } from "react";
import {
	CodeHighlighter,
	getIsDarkMode,
	subscribeToDarkMode,
} from "../../lib/shikiUtils";

function getMermaidTheme(): "dark" | "default" {
	return getIsDarkMode() ? "dark" : "default";
}

interface MermaidBlockProps {
	code: string;
}

export function MermaidBlock({ code }: MermaidBlockProps) {
	const id = useId().replace(/:/g, "-");
	const [svg, setSvg] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const theme = useSyncExternalStore(
		subscribeToDarkMode,
		getMermaidTheme,
		(): "dark" | "default" => "default",
	);

	useLayoutEffect(() => {
		let cancelled = false;

		async function render() {
			try {
				mermaid.initialize({
					startOnLoad: false,
					theme,
					suppressErrorRendering: true,
				});
				const { svg } = await mermaid.render(`mermaid-${id}`, code);
				if (!cancelled) {
					setSvg(svg);
					setError(null);
				}
			} catch (e) {
				if (!cancelled) {
					setError(e instanceof Error ? e.message : "Failed to render diagram");
					setSvg(null);
				}
			}
		}

		render();

		return () => {
			cancelled = true;
		};
	}, [id, code, theme]);

	if (error) {
		return <CodeHighlighter language="mermaid">{code}</CodeHighlighter>;
	}

	if (!svg) {
		return (
			<div className="flex items-center justify-center p-4 text-th-text-muted">
				Loading diagram...
			</div>
		);
	}

	return (
		<div
			className="overflow-x-auto [&_svg]:max-w-full"
			// biome-ignore lint/security/noDangerouslySetInnerHtml: SVG from mermaid.render() is trusted
			dangerouslySetInnerHTML={{ __html: svg }}
		/>
	);
}
