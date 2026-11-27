/**
 * Which components rendered in each React commit, and for how long, read the
 * way React DevTools reads it: through `__REACT_DEVTOOLS_GLOBAL_HOOK__`, which
 * React calls with the root after every commit.
 *
 * Must be installed before `react-dom` is first imported — React looks for the
 * hook once, at load, and only then builds its fibers in profiling mode, which
 * is what gives each one a `selfBaseDuration` (its own render, hooks
 * included, children not). That is why it is a setup file of the bench config.
 */

/** The fiber fields read here; React's own type is not exported. */
interface Fiber {
	tag: number;
	type: unknown;
	elementType: unknown;
	flags: number;
	child: Fiber | null;
	sibling: Fiber | null;
	alternate: Fiber | null;
	selfBaseDuration?: number;
}

interface FiberRoot {
	current: Fiber;
}

export interface ComponentCost {
	renders: number;
	selfMs: number;
}

// React's fiber tags for the components that run user code
// (react-reconciler/src/ReactWorkTags.js).
const FUNCTION_COMPONENT = 0;
const FORWARD_REF = 11;
const SIMPLE_MEMO_COMPONENT = 15;
// Not MemoComponent (14), a `memo` with a compare function: React marks the
// wrapper as having performed work whenever the function it wraps — a fiber
// of its own, counted here — renders, so it would be counted twice.
const COMPONENT_TAGS = new Set([
	FUNCTION_COMPONENT,
	FORWARD_REF,
	SIMPLE_MEMO_COMPONENT,
]);
// ReactFiberFlags.PerformedWork: set on a fiber whose render function ran in
// the render being committed. Cleared when the fiber is next cloned.
const PERFORMED_WORK = 1;

function nameOf(fiber: Fiber): string {
	const type = (fiber.type ?? fiber.elementType) as
		| { displayName?: string; name?: string; render?: { name?: string } }
		| undefined;
	return (
		type?.displayName ||
		type?.name ||
		type?.render?.name ||
		`(tag ${fiber.tag})`
	);
}

let recording = false;
let bundleType: number | undefined;
let costs = new Map<string, ComponentCost>();
let commits = 0;

/**
 * Visits only fibers this commit built: a parent that bailed out without
 * cloning its children still points at the same child object as its previous
 * self, and that subtree is skipped whole — its flags are left over from
 * whichever commit last rendered it.
 */
function visit(fiber: Fiber) {
	const prev = fiber.alternate;
	if (
		COMPONENT_TAGS.has(fiber.tag) &&
		(prev === null || (fiber.flags & PERFORMED_WORK) !== 0)
	) {
		const name = nameOf(fiber);
		const cost = costs.get(name) ?? { renders: 0, selfMs: 0 };
		cost.renders++;
		cost.selfMs += fiber.selfBaseDuration ?? 0;
		costs.set(name, cost);
	}
	if (prev !== null && prev.child === fiber.child) return;
	for (let child = fiber.child; child; child = child.sibling) visit(child);
}

export function installCommitProfiler() {
	const target = window as unknown as Record<string, unknown>;
	if (target.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
		throw new Error("a React DevTools hook is already installed");
	}
	target.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
		isDisabled: false,
		supportsFiber: true,
		renderers: new Map(),
		inject: (internals: { bundleType?: number }) => {
			bundleType = internals.bundleType;
			return 1;
		},
		checkDCE: () => {},
		onScheduleFiberRoot: () => {},
		onCommitFiberUnmount: () => {},
		onPostCommitFiberRoot: () => {},
		onCommitFiberRoot: (_id: number, root: FiberRoot) => {
			if (!recording) return;
			commits++;
			visit(root.current);
		},
	};
}

/** Starts counting from zero. */
export function startRecording() {
	costs = new Map();
	commits = 0;
	recording = true;
}

export function stopRecording(): {
	commits: number;
	costs: Map<string, ComponentCost>;
} {
	recording = false;
	return { commits, costs };
}

/** Which React build registered itself: what the timings were taken on. */
export function reactBuild(): "development" | "production" | "unknown" {
	// react-reconciler's injectIntoDevTools: 1 in a development build.
	if (bundleType === 1) return "development";
	if (bundleType === 0) return "production";
	return "unknown";
}
