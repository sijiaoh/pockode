import { Component, type ReactNode } from "react";

export interface ErrorBoundaryProps {
	children: ReactNode;
	/**
	 * Drawn in place of `children` once they throw while rendering. `reset`
	 * draws them again, for a failure that may not repeat.
	 */
	fallback: (error: Error, reset: () => void) => ReactNode;
	/**
	 * Whatever the children are showing — a path, a diff. A new value draws
	 * them again: the failure belonged to what they were showing before, and
	 * the next file deserves its own chance.
	 */
	resetKey?: unknown;
}

interface State {
	error: Error | null;
	resetKey: unknown;
}

/**
 * Keeps a render-time throw inside the subtree that threw.
 *
 * Without one React unmounts the whole root, so one file a parser chokes on
 * takes the app down with it. Only render, lifecycle and effect errors are
 * caught — that is React's rule — so a failed load still has to be reported
 * by whatever made the request.
 *
 * React logs every caught error itself, with its component stack
 * (`onCaughtError`), so the console has more than the fallback says.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
	state: State = { error: null, resetKey: this.props.resetKey };

	static getDerivedStateFromError(error: unknown): Partial<State> {
		return { error: error instanceof Error ? error : new Error(String(error)) };
	}

	static getDerivedStateFromProps(
		props: ErrorBoundaryProps,
		state: State,
	): Partial<State> | null {
		// Compared during render rather than after it, so the children for the
		// new key are drawn in the same pass instead of one frame of the old
		// error first.
		if (Object.is(props.resetKey, state.resetKey)) return null;
		return { error: null, resetKey: props.resetKey };
	}

	reset = () => {
		this.setState({ error: null });
	};

	render() {
		const { error } = this.state;
		if (error) return this.props.fallback(error, this.reset);
		return this.props.children;
	}
}
