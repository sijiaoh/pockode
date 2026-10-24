import type { Entry } from "../types/contents";
import { attachmentUrl, DOWNLOAD_MIME } from "./fileDownload";

/**
 * The type a tree row's drag carries. Custom rather than `text/plain` or
 * `text/uri-list`: with either one, a row released over the chat composer or
 * the search field would be typed into it.
 */
export const ENTRY_DRAG_TYPE = "application/x-pockode-entry";

/**
 * Chromium's type for a drag that saves a file where it is let go outside the
 * browser: `<mime>:<file name>:<absolute URL>`, fetched by the browser itself
 * at the drop. Other browsers take it as opaque data and do nothing with it.
 */
const DOWNLOAD_URL_TYPE = "DownloadURL";

const ZIP_MIME = "application/zip";

/**
 * Whether letting a row go outside the browser can save it there: only
 * Chromium reads `DownloadURL`, and nothing can be asked to find out, so the
 * browser is named. `userAgentData` is missing outside a secure context — a
 * server reached over plain HTTP by its address — so the user agent string
 * stands in; every Chromium browser carries `Chrome/` in it, and neither
 * Firefox nor Safari does. Elsewhere no capability is asked for and none is
 * put into a drag: it would travel with the drag and save nothing.
 */
export function canDragOutDownload(): boolean {
	const brands = (
		navigator as Navigator & {
			userAgentData?: { brands: { brand: string }[] };
		}
	).userAgentData?.brands;
	if (brands) return brands.some(({ brand }) => brand === "Chromium");
	return /\bChrome\//.test(navigator.userAgent);
}

/** The name a row is saved under: a folder as the zip the server builds. */
export function dragOutFileName(entry: Pick<Entry, "name" | "type">): string {
	return entry.type === "dir" ? `${entry.name}.zip` : entry.name;
}

/**
 * Fills a tree row's drag in. The one place what a row drag carries is
 * written.
 *
 * The payload is the drag's identity, and — given `downloadUrl`, a raw
 * capability for the entry — what saves it when it is let go outside the
 * browser. During `dragover` a page can read `types` and nothing else, so
 * whoever checks a target against the source reads the source from where it
 * was recorded at `dragstart`, not from here.
 */
export function writeEntryDrag(
	dataTransfer: DataTransfer,
	entry: Pick<Entry, "path" | "type" | "name">,
	downloadUrl: string | null = null,
): void {
	const fileName = dragOutFileName(entry);
	// The browser reads the name up to the next `:` and the URL after it, so a
	// name with one in it would be cut short and its rest taken as the URL.
	const download = downloadUrl !== null && !fileName.includes(":");
	// A drop outside the browser is a copy; inside the tree, `dropEffect`
	// still says move.
	dataTransfer.effectAllowed = download ? "copyMove" : "move";
	dataTransfer.setData(
		ENTRY_DRAG_TYPE,
		JSON.stringify({ path: entry.path, type: entry.type }),
	);
	if (download) {
		const mime = entry.type === "dir" ? ZIP_MIME : DOWNLOAD_MIME;
		dataTransfer.setData(
			DOWNLOAD_URL_TYPE,
			`${mime}:${fileName}:${attachmentUrl(downloadUrl)}`,
		);
	}
}

export function carriesEntry(dataTransfer: DataTransfer | null): boolean {
	if (!dataTransfer) return false;
	return Array.from(dataTransfer.types).includes(ENTRY_DRAG_TYPE);
}
