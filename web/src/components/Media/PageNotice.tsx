import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Why the files a page links to will not load. The page still renders — many
 * single-file pages work — so this sits above it and stays while that is
 * true: hiding it would leave a page that looks broken for no stated reason.
 */
function PageNotice({ children }: { children: ReactNode }) {
	return (
		<div
			role="note"
			className="flex shrink-0 gap-2 border-b border-th-border bg-th-warning/10 px-3 py-2 text-xs text-th-text-secondary"
		>
			<TriangleAlert
				className="mt-0.5 size-3.5 shrink-0 text-th-warning"
				aria-hidden="true"
			/>
			<p className="min-w-0">{children}</p>
		</div>
	);
}

export default PageNotice;
