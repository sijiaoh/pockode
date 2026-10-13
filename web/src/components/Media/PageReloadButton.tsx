import { RotateCw } from "lucide-react";
import { type HeaderButtonSize, headerButtonClass } from "../ui";
import type { usePageFrame } from "./usePageFrame";

interface Props {
	page: ReturnType<typeof usePageFrame>;
	size: HeaderButtonSize;
}

/**
 * ↻ for a page frame, where the page is in place and in the viewer: Reload,
 * or Retry on a failure card. Pressable while it spins — a page stuck on an
 * asset that never arrives is exactly the one to reload.
 */
export function PageReloadButton({ page, size }: Props) {
	return (
		<button
			type="button"
			onClick={page.failure ? page.retry : page.reload}
			aria-label="Reload page"
			title="Reload page"
			className={headerButtonClass(size)}
		>
			<RotateCw
				size={size === "lg" ? 16 : 14}
				aria-hidden="true"
				className={page.loading ? "animate-spin" : undefined}
			/>
		</button>
	);
}
