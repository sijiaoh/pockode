import {
	createContext,
	type ReactNode,
	useContext,
	useLayoutEffect,
	useState,
	useSyncExternalStore,
} from "react";

interface Source<T> {
	get: () => T;
	subscribe: (listener: () => void) => () => void;
}

class ValueSource<T> implements Source<T> {
	private value: T;
	private published: T;
	// A render wrote a value its readers were never told of. Usually it is the
	// one about to be published; after a render that was thrown away, it may be
	// one that never commits, and a reader drawn meanwhile has to be told too.
	private ahead = false;
	private readonly listeners = new Set<() => void>();

	constructor(value: T) {
		this.value = value;
		this.published = value;
	}

	/** During render: readers drawn in this pass read it. */
	write(value: T) {
		this.value = value;
		if (!Object.is(value, this.published)) this.ahead = true;
	}

	get = () => this.value;

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	/** Once committed: the value is the committed one, and every reader is told. */
	publish(value: T) {
		this.value = value;
		if (!this.ahead && Object.is(this.published, value)) return;
		this.ahead = false;
		this.published = value;
		for (const listener of this.listeners) listener();
	}
}

/**
 * A context whose readers each take their own slice of the value, and are
 * re-rendered only when that slice changes.
 *
 * For a value that changes while a long transcript streams and is read by a
 * few rows deep inside memoized bubbles. A plain context changing makes React
 * walk the whole tree under its provider looking for readers — every bubble
 * bails out, so the walk goes through all of them — and on a long session that
 * walk alone was tens of milliseconds per streamed record. Here the context
 * only ever carries one object, which never changes; the value travels through
 * a subscription instead.
 *
 * The provider takes a plain `value`, so it is written like a context's.
 * Readers rendering in the same pass read the new value straight away; the
 * rest are told once the commit is in, and redraw in a commit of their own
 * before paint — after the layout effects of the first, so a size they change
 * reaches the transcript through its ResizeObserver rather than its layout
 * effect.
 */
export function createSelectableContext<T>(fallback: T) {
	const fixed: Source<T> = {
		get: () => fallback,
		subscribe: () => () => {},
	};
	const SourceContext = createContext<Source<T>>(fixed);

	function Provider({ value, children }: { value: T; children?: ReactNode }) {
		const [source] = useState(() => new ValueSource(value));
		// Written during render so that a reader drawn in this same pass — one
		// just mounted, or one its parent redrew — does not draw the old value.
		source.write(value);
		useLayoutEffect(() => source.publish(value));
		return <SourceContext value={source}>{children}</SourceContext>;
	}

	/**
	 * `select` must return the same thing for the same value — a part of it,
	 * or a primitive — or the reader redraws on every change.
	 */
	function useSelect<S>(select: (value: T) => S): S {
		const source = useContext(SourceContext);
		const snapshot = () => select(source.get());
		return useSyncExternalStore(source.subscribe, snapshot, snapshot);
	}

	return [Provider, useSelect] as const;
}
