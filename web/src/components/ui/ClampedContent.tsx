import { Sheet } from "@pockode/shared";
import { Maximize2 } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

interface Props {
	children: ReactNode;
	/**
	 * Which end stays in view while clamped. `end` for output that is read from
	 * its tail — a build's verdict is its last line, not its first.
	 */
	from?: "start" | "end";
	/**
	 * Offer the content a screen of its own under this title, for what is read
	 * at length — a whole file, a long diff — rather than merely skimmed.
	 */
	fullScreenTitle?: string;
	/**
	 * What the button that opens it says, when the content has a count of its
	 * own worth naming — a command's output is read by its lines.
	 */
	showAllLabel?: string;
}

const FADE_START =
	"[mask-image:linear-gradient(to_bottom,black_calc(100%-3rem),transparent)]";
const FADE_END =
	"[mask-image:linear-gradient(to_top,black_calc(100%-3rem),transparent)]";

/**
 * Long content cut to a fixed height, faded where it is cut, and opened in
 * place on request.
 *
 * Instead of a scroll box, because a scroll box inside a scrolling transcript
 * is a trap on a touch screen: a drag meant for the page is taken by whichever
 * box is under the thumb, and on a phone a tall one is under it most of the
 * time. Clipped content scrolls nothing, so every vertical drag stays the
 * page's. Sideways it does scroll — a file's lines keep their width — and a box
 * with nothing to scroll vertically hands a vertical drag on to the page.
 */
export function ClampedContent({
	children,
	from = "start",
	fullScreenTitle,
	showAllLabel = "Show all",
}: Props) {
	const boxRef = useRef<HTMLDivElement>(null);
	const [overflowing, setOverflowing] = useState(false);
	const [showAll, setShowAll] = useState(false);
	const [fullScreen, setFullScreen] = useState(false);

	// Measured before paint, so content that fits never flashes its button. The
	// content element is what is observed: the box's own height is pinned at the
	// clamp the moment it overflows, and stops changing.
	useLayoutEffect(() => {
		const box = boxRef.current;
		const content = box?.firstElementChild;
		if (!box || !(content instanceof HTMLElement) || showAll) return;

		// The content's height and not the box's `scrollHeight`: an end-anchored
		// column overflows upwards, and overflow on that side is not scrollable
		// overflow, so `scrollHeight` never exceeds the box there.
		const measure = () =>
			setOverflowing(content.offsetHeight > box.clientHeight + 1);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(content);
		return () => observer.disconnect();
	}, [showAll]);

	const clamped = overflowing && !showAll;

	return (
		<div>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: the focus listener only watches focus arriving at a control inside; the box itself takes none */}
			<div
				ref={boxRef}
				data-clamped={clamped || undefined}
				// A keyboard reaching a control in the cut-off part would make the
				// browser scroll this clipped box to it — scrolling a box the user
				// cannot scroll back. Opening it instead keeps the box at rest.
				onFocus={(e) => {
					if (clamped && e.target.matches(":focus-visible")) setShowAll(true);
				}}
				// `overflow-y-hidden` is not only the clip: `overflow-x-auto` alone
				// would make the other axis `auto` as well, and the box a vertical
				// scroller again.
				className={`overflow-x-auto overflow-y-hidden ${
					showAll ? "" : "max-h-80"
				} ${from === "end" ? "flex flex-col justify-end" : ""} ${
					clamped ? (from === "end" ? FADE_END : FADE_START) : ""
				}`}
			>
				{/* One element, so there is one height to watch. `shrink-0` keeps
				    the end-anchored column from squeezing it to the box instead of
				    letting it overflow the top. */}
				<div className="min-w-0 shrink-0">{children}</div>
			</div>
			{(clamped || (overflowing && fullScreenTitle)) && (
				<div className="flex items-center gap-2 pt-1">
					{clamped && (
						<button
							type="button"
							onClick={() => setShowAll(true)}
							className="min-h-[36px] rounded px-2 text-th-accent pointer-coarse:min-h-11 hover:bg-th-overlay-hover"
						>
							{showAllLabel}
						</button>
					)}
					{fullScreenTitle && (
						<button
							type="button"
							onClick={() => setFullScreen(true)}
							className="flex min-h-[36px] items-center gap-1 rounded px-2 text-th-accent pointer-coarse:min-h-11 hover:bg-th-overlay-hover"
						>
							<Maximize2 className="size-3" aria-hidden="true" />
							Full screen
						</button>
					)}
				</div>
			)}
			{fullScreen && fullScreenTitle && (
				<Sheet
					title={fullScreenTitle}
					onClose={() => setFullScreen(false)}
					fullScreen
				>
					<div className="overflow-x-auto p-2 text-xs">{children}</div>
				</Sheet>
			)}
		</div>
	);
}
