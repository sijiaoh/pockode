import type { ComponentType, KeyboardEvent, RefObject } from "react";
import type { ImageDimensions, ImageSource } from "../../utils/fileView";

/**
 * Something the media viewer can show. One member per kind; each kind has a
 * stage of its own (`stages.ts`) and shares everything else.
 */
export type MediaItem = ImageMediaItem;

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
	 * Reports the media's real size once known, for the caption — and null when
	 * the bytes change, so a size the new bytes have not confirmed is not shown.
	 */
	onDimensions: (dimensions: ImageDimensions | null) => void;
}

export type StageComponent<Item extends MediaItem = MediaItem> = ComponentType<
	StageProps<Item>
>;
