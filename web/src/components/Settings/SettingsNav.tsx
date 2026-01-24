import { useCallback, useEffect, useRef, useState } from "react";

export interface NavItem {
	id: string;
	label: string;
}

interface Props {
	items: NavItem[];
	scrollContainerRef: React.RefObject<HTMLElement | null>;
}

const SCROLL_OFFSET = 16;

export default function SettingsNav({ items, scrollContainerRef }: Props) {
	const [activeId, setActiveId] = useState(items[0]?.id ?? "");
	const navRef = useRef<HTMLDivElement>(null);
	const isScrollingToSection = useRef(false);

	const getActiveIdByPosition = useCallback(() => {
		const container = scrollContainerRef.current;
		if (!container || items.length === 0) return items[0]?.id ?? "";

		// If scrolled to bottom, activate the last item
		const isAtBottom =
			Math.abs(
				container.scrollHeight - container.scrollTop - container.clientHeight,
			) < 1;
		if (isAtBottom) {
			return items[items.length - 1].id;
		}

		// Find the topmost section that has scrolled past the threshold
		const containerRect = container.getBoundingClientRect();
		let currentId = items[0].id;

		for (const item of items) {
			const section = document.getElementById(item.id);
			if (!section) continue;

			const sectionTop =
				section.getBoundingClientRect().top - containerRect.top;
			if (sectionTop <= SCROLL_OFFSET * 2) {
				currentId = item.id;
			}
		}

		return currentId;
	}, [items, scrollContainerRef]);

	const scrollToSection = useCallback(
		(id: string) => {
			const container = scrollContainerRef.current;
			const section = document.getElementById(id);
			if (!container || !section) return;

			isScrollingToSection.current = true;
			setActiveId(id);

			const containerRect = container.getBoundingClientRect();
			const sectionRect = section.getBoundingClientRect();
			const offset = sectionRect.top - containerRect.top + container.scrollTop;

			container.scrollTo({
				top: offset - SCROLL_OFFSET,
				behavior: "smooth",
			});
		},
		[scrollContainerRef],
	);

	useEffect(() => {
		const container = scrollContainerRef.current;
		if (!container) return;

		let scrollEndTimeout: ReturnType<typeof setTimeout> | undefined;
		const supportsScrollEnd = "onscrollend" in window;

		const handleScroll = () => {
			if (isScrollingToSection.current) return;
			setActiveId(getActiveIdByPosition());
		};

		const handleScrollEnd = () => {
			isScrollingToSection.current = false;
		};

		const handlePointerDown = () => {
			if (isScrollingToSection.current) {
				isScrollingToSection.current = false;
				setActiveId(getActiveIdByPosition());
			}
		};

		// Fallback: detect scroll end via debounce for browsers without scrollend
		const handleScrollEndFallback = () => {
			clearTimeout(scrollEndTimeout);
			scrollEndTimeout = setTimeout(handleScrollEnd, 150);
		};

		container.addEventListener("scroll", handleScroll, { passive: true });
		container.addEventListener("pointerdown", handlePointerDown, {
			passive: true,
		});

		if (supportsScrollEnd) {
			container.addEventListener("scrollend", handleScrollEnd, {
				passive: true,
			});
		} else {
			container.addEventListener("scroll", handleScrollEndFallback, {
				passive: true,
			});
		}

		return () => {
			container.removeEventListener("scroll", handleScroll);
			container.removeEventListener("pointerdown", handlePointerDown);
			if (supportsScrollEnd) {
				container.removeEventListener("scrollend", handleScrollEnd);
			} else {
				container.removeEventListener("scroll", handleScrollEndFallback);
				clearTimeout(scrollEndTimeout);
			}
		};
	}, [scrollContainerRef, getActiveIdByPosition]);

	// Center active button in nav
	useEffect(() => {
		const nav = navRef.current;
		const activeButton = nav?.querySelector(`[data-id="${activeId}"]`);
		if (nav && activeButton) {
			const navRect = nav.getBoundingClientRect();
			const buttonRect = activeButton.getBoundingClientRect();
			const scrollLeft =
				buttonRect.left -
				navRect.left +
				nav.scrollLeft -
				navRect.width / 2 +
				buttonRect.width / 2;
			nav.scrollTo({ left: scrollLeft, behavior: "smooth" });
		}
	}, [activeId]);

	return (
		<nav
			ref={navRef}
			className="flex gap-1 overflow-x-auto border-b border-th-border bg-th-bg-secondary px-2 py-1 scrollbar-none"
			aria-label="Settings sections"
		>
			{items.map((item) => (
				<button
					key={item.id}
					type="button"
					data-id={item.id}
					aria-pressed={activeId === item.id}
					onClick={() => scrollToSection(item.id)}
					className={`shrink-0 rounded-full px-4 py-2.5 text-xs transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95 ${
						activeId === item.id
							? "bg-th-accent text-white"
							: "bg-th-bg-tertiary text-th-text-muted hover:text-th-text-secondary"
					}`}
				>
					{item.label}
				</button>
			))}
		</nav>
	);
}
