import type { MediaKind, StageComponent } from "./types";

/**
 * Each kind's stage, imported only when an item of that kind is first opened:
 * a stage carries what draws and moves its media (the image stage brings
 * `react-zoom-pan-pinch`), and none of it belongs in the initial bundle.
 */
const loaders: Record<MediaKind, () => Promise<StageComponent>> = {
	image: () =>
		import("./ImageStage").then((module) => module.default as StageComponent),
	video: () =>
		import("./VideoStage").then((module) => module.default as StageComponent),
};

const loaded = new Map<MediaKind, StageComponent>();

/** The stage for `kind` if it has already loaded, so a reopen draws at once. */
export function loadedStage(kind: MediaKind): StageComponent | undefined {
	return loaded.get(kind);
}

export async function loadStage(kind: MediaKind): Promise<StageComponent> {
	const stage = await loaders[kind]();
	loaded.set(kind, stage);
	return stage;
}
