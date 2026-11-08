import type { ReactNode, Ref } from "react";
import {
	LandingContext,
	useRestoredScroller,
} from "../../hooks/useScrollRestoration";

interface Props {
	children: ReactNode;
	ref?: Ref<HTMLDivElement>;
}

/**
 * The scrolling body of a page, under its `PageHeader`. Write a page's body as
 * this rather than a bare `overflow-auto` div: it is what brings the reader
 * back to where they were when they return to the page, and what lands a
 * fresh visit where its content asks (`useFreshVisitLanding`).
 */
export default function PageBody({ children, ref }: Props) {
	const { ref: restoringRef, land } = useRestoredScroller(ref);
	return (
		<div ref={restoringRef} className="min-h-0 flex-1 overflow-auto">
			<LandingContext value={land}>{children}</LandingContext>
		</div>
	);
}
