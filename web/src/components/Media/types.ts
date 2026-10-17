import type { ComponentType, KeyboardEvent, RefObject } from "react";
import type { ContentOrigin, TreeOrigin } from "../../types/contents";
import type { ImageDimensions, ImageSource } from "../../utils/fileView";

/**
 * Something the media viewer can show. One member per kind; each kind has a
 * stage of its own (`stages.ts`) and shares everything else.
 */
export type MediaItem = ImageMediaItem | VideoMediaItem | HtmlMediaItem;

export interface ImageMediaItem {
	kind: "image";
	/** Shown as the viewer's title. */
	name: string;
	/** The file name Save writes. */
	saveAs: string;
	mime: string;
	size: number;
	source: ImageSource;
	/** What the bytes will decode to, when something already knows. */
	dimensions?: ImageDimensions;
}

export interface VideoMediaItem {
	kind: "video";
	/** Shown as the viewer's title. */
	name: string;
	/** The file name Save writes. */
	saveAs: string;
	mime: string;
	size: number;
	/** What the stage asks a raw capability for, shared with the opener's. */
	origin: ContentOrigin;
	/** What the opener's player already learnt from the metadata. */
	dimensions?: ImageDimensions;
	duration?: number;
	/**
	 * Where playback carries on from, written back as it moves so the opener
	 * can pick up where the viewer left off (docs/media-viewer.md#handover).
	 */
	handoff?: PlaybackHandoff;
}

export interface HtmlMediaItem {
	kind: "html";
	/** Shown as the viewer's title. */
	name: string;
	/** The file name Save writes. */
	saveAs: string;
	mime: string;
	size: number;
	/**
	 * The page, loaded through the same capability as the opener's frame — its
	 * tree's root, so the page's assets load too.
	 */
	origin: TreeOrigin;
	/** See `usePageFrame`: a change loads the page again, as in place. */
	revision?: unknown;
	/** Set when the opener shows `PageNotice`, for the viewer to show it too. */
	notice?: boolean;
}

/** A position passed between two players of the same file. Mutable. */
export interface PlaybackHandoff {
	time: number;
	/** Whether the user had it playing, so the receiving player plays too. */
	playing: boolean;
}

/** What a stage learns about its media once it has loaded, for the caption. */
export interface MediaMetadata {
	/** Null for a video with no picture this browser can show. */
	dimensions: ImageDimensions | null;
	/** Null when the media has none, or the file does not say. */
	duration: number | null;
}

export type MediaKind = MediaItem["kind"];

export type StageKeyHandler = (event: KeyboardEvent) => void;

/** What the viewer hands the stage it loaded for an item's kind. */
export interface StageProps<Item extends MediaItem> {
	item: Item;
	/**
	 * The toolbar's start, for the stage's own controls to be portalled into.
	 * Null until the toolbar has mounted.
	 */
	toolbarStart: HTMLElement | null;
	/**
	 * Where the stage registers what the keys do. The viewer's frame holds focus
	 * and forwards to it, so the keys work from the moment the viewer opens,
	 * before the stage has even loaded.
	 */
	keysRef: RefObject<StageKeyHandler | null>;
	/**
	 * Reports the media's real size and length once known, for the caption — and
	 * null when the bytes change, so what the new bytes have not confirmed is
	 * not shown.
	 */
	onMetadata: (metadata: MediaMetadata | null) => void;
	/**
	 * Where a stage that knows better than the item what Save downloads
	 * registers the URL: a page's is the one it loaded from, under its own
	 * capability. Null while there is none.
	 */
	saveUrlRef: RefObject<string | null>;
}

export type StageComponent<Item extends MediaItem = MediaItem> = ComponentType<
	StageProps<Item>
>;
