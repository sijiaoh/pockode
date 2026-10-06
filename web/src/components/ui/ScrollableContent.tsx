import { ChevronDown } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";

interface Props {
	children: React.ReactNode;
	className?: string;
	/** The scrolling element itself, not the wrapper the indicator sits in. */
	ref?: RefObject<HTMLDivElement | null>;
}

/** Scrollable container with bottom scroll indicator */
function ScrollableContent({ children, className, ref }: Props) {
	const ownRef = useRef<HTMLDivElement>(null);
	const containerRef = ref ?? ownRef;
	const [canScrollDown, setCanScrollDown] = useState(false);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;

		const checkScroll = () => {
			const isScrollable = el.scrollHeight > el.clientHeight;
			const isAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
			setCanScrollDown(isScrollable && !isAtBottom);
		};

		checkScroll();
		el.addEventListener("scroll", checkScroll, { passive: true });

		const resizeObserver = new ResizeObserver(checkScroll);
		resizeObserver.observe(el);

		const mutationObserver = new MutationObserver(checkScroll);
		mutationObserver.observe(el, {
			childList: true,
			subtree: true,
			characterData: true,
		});

		return () => {
			el.removeEventListener("scroll", checkScroll);
			resizeObserver.disconnect();
			mutationObserver.disconnect();
		};
	}, [containerRef]);

	return (
		<div className="relative">
			<div ref={containerRef} className={className}>
				{children}
			</div>
			{canScrollDown && (
				<div className="pointer-events-none absolute bottom-0 left-0 right-0 flex h-8 items-end justify-center bg-gradient-to-t from-white/60 to-transparent pb-0.5 dark:from-black/50">
					<ChevronDown
						className="h-3.5 w-3.5 text-th-text-muted"
						strokeWidth={2.5}
						aria-hidden="true"
					/>
				</div>
			)}
		</div>
	);
}

export default ScrollableContent;
