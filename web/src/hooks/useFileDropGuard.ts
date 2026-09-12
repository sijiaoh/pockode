import { useEffect } from "react";

function carriesFiles(dataTransfer: DataTransfer | null): boolean {
	if (!dataTransfer) return false;
	// `types` is what a drag exposes before it is dropped; `items` cannot be read
	// during `dragover`.
	return Array.from(dataTransfer.types).includes("Files");
}

/**
 * Keeps a file dropped anywhere outside a drop zone from replacing the app.
 *
 * The browser's default action for a file dropped on a page is to navigate to
 * that file, so a drag released a few pixels wide of the Files tab throws away
 * the whole session — not an edge case, but what happens every time someone
 * misses. Mount this once, high enough to be alive for every page.
 *
 * The listeners run in the capture phase so that a real drop zone, whose React
 * handler runs later on the way back up, still gets to claim the drag with
 * `dropEffect = "copy"`. Anywhere else the cursor keeps the "not allowed" mark
 * set here, which is the truth: nothing there accepts the file.
 */
export function useFileDropGuard(): void {
	useEffect(() => {
		const refuse = (event: DragEvent) => {
			if (!carriesFiles(event.dataTransfer)) return;
			event.preventDefault();
			if (event.type === "dragover" && event.dataTransfer) {
				event.dataTransfer.dropEffect = "none";
			}
		};

		window.addEventListener("dragover", refuse, true);
		window.addEventListener("drop", refuse, true);
		return () => {
			window.removeEventListener("dragover", refuse, true);
			window.removeEventListener("drop", refuse, true);
		};
	}, []);
}
