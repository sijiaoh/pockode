/**
 * What a layer's history entries need of the app's history. The app gives one
 * (`LayerHistoryContext`): `web` over its router's history, `web-cluster` over
 * `window.history`. The entries are the app's; this module only decides when
 * one is pushed or gone back over (docs/project-ui.md §5.2).
 */
export interface LayerEntries {
	/** The current entry's position in the tab's history, if known. */
	index(): number | undefined;
	/**
	 * The layers whose entries are at or below the current one, bottom first:
	 * what the current entry was pushed carrying. Empty on a page's own entry.
	 */
	layers(): readonly string[];
	/**
	 * Pushes a copy of the current entry — the same href, the same page —
	 * carrying `layers`. Never held: this is the entry a layer holds.
	 */
	push(layers: readonly string[]): void;
	/** Goes `delta` entries (negative: back). */
	go(delta: number): void;
	/**
	 * Hears every traversal — Back, Forward, a `go()` — once the current entry
	 * is the one arrived at. Not pushes or replaces.
	 */
	subscribe(listener: () => void): () => void;
}

/** What Back does to one layer. */
export interface LayerBack {
	/** The layer's plain close — what ✕ or Cancel calls, and nothing else. */
	onBack: () => void;
	/**
	 * True while the layer refuses to close: a Back that lands right under it
	 * is answered by pushing its entry again. Read at the time of the Back.
	 */
	refuse: () => boolean;
}

export interface LayerHistory {
	/**
	 * Holds an entry for a layer from now until the returned close: pushed a
	 * tick late, and taken back by the close if it is still on top.
	 */
	open(layer: LayerBack): () => void;
	/**
	 * Goes back over every layer entry; the layers it passes close, refusing
	 * or not. Resolves once the page's own entry is current — where a held
	 * navigation is made from.
	 */
	unwind(): Promise<void>;
	/**
	 * Whether a navigation made now would go over a layer: an entry is up, or
	 * one is being pushed or gone back over.
	 */
	readonly busy: boolean;
	/** Resolves once no layer entry is being pushed or gone back over. */
	settled(): Promise<void>;
}

/**
 * How long a traversal of ours is waited for before it is taken to have
 * landed: one that never reports — a browser dropping the `popstate`, a `go()`
 * past the start — must not leave the layers after it waiting for ever.
 */
const LANDING_TIMEOUT_MS = 1000;

interface OpenLayer {
	id: string;
	back: LayerBack;
	/** The position of its entry once pushed; undefined until then. */
	index: number | undefined;
	pushed: boolean;
	closed: boolean;
}

/**
 * The one stack of layers over the page and their entries.
 *
 * Every move of an entry is queued behind the one before it: a layer opening
 * as another closes (a menu sheet replaced by its confirmation) pushes only
 * once the first one's entry is gone, or the `back()` would take the new
 * entry instead of the old one.
 */
export function createLayerHistory(entries: LayerEntries): LayerHistory {
	const open: OpenLayer[] = [];
	let queue: Promise<void> = Promise.resolve();
	let queued = 0;
	/** Resolves the traversal of ours under way, on its arrival. */
	let landing: (() => void) | null = null;
	// Random per document: an entry left by a document before a reload must
	// never be owned by a layer of this one.
	const prefix = Math.random().toString(36).slice(2);
	let count = 0;

	const enqueue = (task: () => Promise<void> | void): Promise<void> => {
		queued += 1;
		const run = queue.then(task).finally(() => {
			queued -= 1;
		});
		queue = run.catch(() => {});
		return queue;
	};

	const go = (delta: number) =>
		new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(fallback);
				if (landing === done) landing = null;
				resolve();
			};
			const fallback = setTimeout(done, LANDING_TIMEOUT_MS);
			// Before the `go()`: a memory history reports it from inside the call.
			landing = done;
			entries.go(delta);
		});

	const isLive = (id: string) =>
		open.some((layer) => layer.id === id && layer.pushed);

	/**
	 * How many entries at the top belong to no layer that is still up. Counted
	 * down from the top and stopped at the first live one: a lower layer that
	 * closed under one still up leaves its entry there, and taking it would
	 * take the live one's too — and close it.
	 */
	const deadOnTop = () => {
		const chain = entries.layers();
		let dead = 0;
		while (dead < chain.length && !isLive(chain[chain.length - 1 - dead])) {
			dead += 1;
		}
		return dead;
	};

	const settle = async () => {
		const dead = deadOnTop();
		if (dead > 0) await go(-dead);
	};

	const pushEntry = (layer: OpenLayer) => {
		if (layer.closed) return;
		entries.push([...entries.layers(), layer.id]);
		layer.pushed = true;
		layer.index = entries.index();
	};

	const remove = (layer: OpenLayer) => {
		layer.closed = true;
		const at = open.indexOf(layer);
		if (at >= 0) open.splice(at, 1);
	};

	entries.subscribe(() => {
		const ours = landing !== null;
		const chain = entries.layers();
		const gone = open.filter(
			(layer) => layer.pushed && !chain.includes(layer.id),
		);
		// A layer still waiting to push sat over the page's own entry, which a
		// traversal of the user's has just left.
		const stranded = ours ? [] : open.filter((layer) => !layer.pushed);

		const top = open.filter((layer) => layer.pushed).at(-1);
		const here = entries.index();
		const refused =
			!ours &&
			stranded.length === 0 &&
			gone.length === 1 &&
			gone[0] === top &&
			here !== undefined &&
			top.index !== undefined &&
			here === top.index - 1 &&
			top.back.refuse();

		if (refused) {
			enqueue(() => pushEntry(top));
		} else {
			// Top first, as Escape would put them away.
			for (const layer of [...gone, ...stranded].reverse()) {
				remove(layer);
				layer.back.onBack();
			}
		}
		landing?.();
		// Arrived on an entry whose layer is gone: Forward onto a closed sheet,
		// or a stack whose lower layer closed before the one on top.
		if (deadOnTop() > 0) enqueue(settle);
	});

	return {
		open(back) {
			count += 1;
			const layer: OpenLayer = {
				id: `${prefix}-${count}`,
				back,
				index: undefined,
				pushed: false,
				closed: false,
			};
			open.push(layer);
			// A tick late, so that StrictMode's mount-unmount-mount pushes once.
			const timer = setTimeout(() => enqueue(() => pushEntry(layer)));
			return () => {
				clearTimeout(timer);
				// Closed by a traversal already: its entry is gone.
				if (layer.closed) return;
				const pushed = layer.pushed;
				remove(layer);
				// Only while it is still on top — `settle` reads the entries as
				// they are when its turn comes. One that something pushed over is
				// left, at the cost of one Back that changes nothing.
				if (pushed) enqueue(settle);
			};
		},
		unwind: () =>
			enqueue(async () => {
				const depth = entries.layers().length;
				if (depth > 0) await go(-depth);
			}),
		get busy() {
			return queued > 0 || landing !== null || entries.layers().length > 0;
		},
		settled: () => queue,
	};
}
