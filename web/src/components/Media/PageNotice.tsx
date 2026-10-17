import { TriangleAlert } from "lucide-react";

/**
 * Why the files a page links to will not load, for a page shown on its own
 * (`isHiddenPage`). The page still renders — many single-file pages work — so
 * this sits above it and stays: there is no dismissing a fact about where the
 * file lives.
 */
function PageNotice() {
	return (
		<div
			role="note"
			className="flex shrink-0 gap-2 border-b border-th-border bg-th-warning/10 px-3 py-2 text-xs text-th-text-secondary"
		>
			<TriangleAlert
				className="mt-0.5 size-3.5 shrink-0 text-th-warning"
				aria-hidden="true"
			/>
			<p className="min-w-0">
				Files this page links to won't load: its path has a hidden name
				(starting with a dot), so it is shown on its own.
			</p>
		</div>
	);
}

export default PageNotice;
