import { useEffect, useState } from "react";

// Tailwind md breakpoint (768px)
const MD_BREAKPOINT = 768;

/**
 * Returns true if viewport width >= md breakpoint (768px).
 * Updates reactively on window resize.
 */
export function useIsDesktop(): boolean {
	const [isDesktop, setIsDesktop] = useState(() => {
		if (typeof window === "undefined") return false;
		return window.matchMedia(`(min-width: ${MD_BREAKPOINT}px)`).matches;
	});

	useEffect(() => {
		const mediaQuery = window.matchMedia(`(min-width: ${MD_BREAKPOINT}px)`);

		const handleChange = (e: MediaQueryListEvent) => {
			setIsDesktop(e.matches);
		};

		mediaQuery.addEventListener("change", handleChange);
		return () => mediaQuery.removeEventListener("change", handleChange);
	}, []);

	return isDesktop;
}
