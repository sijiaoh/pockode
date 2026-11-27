import { cdp } from "vitest/browser";

/**
 * V8's sampling profiler, through the DevTools protocol: where the time of a
 * stretch of the benchmark went, by function — including what no React timer
 * sees, such as the reducer, commit-phase effects and the style and layout
 * work a measurement forces (charged to the native call that forced it, e.g.
 * `getBoundingClientRect`).
 */

interface CallFrame {
	functionName: string;
	url: string;
	lineNumber: number;
}

interface ProfileNode {
	id: number;
	callFrame: CallFrame;
	children?: number[];
}

interface Profile {
	nodes: ProfileNode[];
	samples: number[];
	timeDeltas: number[];
}

// Typed by the playwright provider's augmentation, which the app's tsconfig
// does not load.
function session() {
	return cdp() as unknown as {
		send: (method: string, params?: object) => Promise<unknown>;
	};
}

export async function setCpuThrottle(rate: number) {
	await session().send("Emulation.setCPUThrottlingRate", { rate });
}

export async function startProfile() {
	await session().send("Profiler.enable");
	// Microseconds; V8's default is 1000.
	await session().send("Profiler.setSamplingInterval", { interval: 100 });
	await session().send("Profiler.start");
}

/** A function's key: its name and module, the url cut to the source path. */
function keyOf(frame: CallFrame): string {
	const name = frame.functionName || "(anonymous)";
	if (!frame.url) return name;
	const path = frame.url
		.replace(/^https?:\/\/[^/]+/, "")
		.replace(/\?.*$/, "")
		.replace(/^.*\/deps\//, "deps/")
		.replace(/^.*\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?/, "")
		// Served from `/src/…` or, outside the root, `/@fs/<absolute path>`.
		.replace(/^.*?\/src\//, "");
	// No line: the profile's lines are the transformed module's, not the
	// source's, so they would point nowhere useful.
	return `${name} ${path}`;
}

export interface FunctionCost {
	key: string;
	/** Milliseconds spent in the function itself. */
	selfMs: number;
	/** Milliseconds with the function anywhere on the stack. */
	totalMs: number;
}

/** Stops the profiler and totals its samples by function. */
export async function stopProfile(): Promise<FunctionCost[]> {
	const { profile } = (await session().send("Profiler.stop")) as {
		profile: Profile;
	};
	await session().send("Profiler.disable");
	const byId = new Map(profile.nodes.map((node) => [node.id, node]));
	const parent = new Map<number, number>();
	for (const node of profile.nodes) {
		for (const child of node.children ?? []) parent.set(child, node.id);
	}
	const costs = new Map<string, FunctionCost>();
	const cost = (key: string) => {
		let entry = costs.get(key);
		if (!entry) {
			entry = { key, selfMs: 0, totalMs: 0 };
			costs.set(key, entry);
		}
		return entry;
	};
	profile.samples.forEach((id, i) => {
		// A sample's delta is the time since the one before it.
		const ms = (profile.timeDeltas[i + 1] ?? 0) / 1000;
		const leaf = byId.get(id);
		if (!leaf) return;
		// A native call — a DOM query, a layout read — is named with the
		// function that made it, which is what there is to act on.
		const caller = parent.get(id);
		const callerNode = caller === undefined ? undefined : byId.get(caller);
		const native =
			!leaf.callFrame.url && !leaf.callFrame.functionName.startsWith("(");
		const leafKey =
			native && callerNode
				? `${keyOf(leaf.callFrame)} ← ${keyOf(callerNode.callFrame)}`
				: keyOf(leaf.callFrame);
		cost(leafKey).selfMs += ms;
		const seen = new Set<string>();
		for (
			let at: number | undefined = id;
			at !== undefined;
			at = parent.get(at)
		) {
			const node = byId.get(at);
			if (!node) break;
			const key = at === id ? leafKey : keyOf(node.callFrame);
			if (seen.has(key)) continue;
			seen.add(key);
			cost(key).totalMs += ms;
		}
	});
	return [...costs.values()];
}
