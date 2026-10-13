let source: Promise<string> | null = null;

/**
 * Mermaid's self-contained build, as text for the diagram frame to run. The
 * frame cannot fetch it — its policy refuses every request, the app's own
 * server included — so the page loads it once, as a lazy chunk of its own, and
 * hands it over. It is the app's only copy of Mermaid.
 */
export function loadMermaidSource(): Promise<string> {
	source ??= import("mermaid/dist/mermaid.min.js?raw").then(
		(module) => module.default,
		(error: unknown) => {
			// A chunk that failed to load may load on the next diagram.
			source = null;
			throw error;
		},
	);
	return source;
}
