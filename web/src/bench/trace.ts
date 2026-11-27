import { cdp } from "vitest/browser";

/**
 * A Chromium performance trace over the DevTools protocol, totalled by event:
 * what the CPU profile can only show as `(program)` — style recalculation,
 * layout, pre-paint, paint, compositing — with how much of the tree each
 * layout and style pass touched.
 */

interface TraceEvent {
	name: string;
	ph: string;
	dur?: number;
	tid: number;
	args?: {
		beginData?: { dirtyObjects?: number; totalObjects?: number };
		elementCount?: number;
	};
}

function session() {
	return cdp() as unknown as {
		send: (method: string, params?: object) => Promise<unknown>;
		on: (event: string, listener: (payload: never) => void) => void;
		off: (event: string, listener: (payload: never) => void) => void;
	};
}

let events: TraceEvent[] = [];
const collect = (payload: { value: TraceEvent[] }) => {
	events.push(...payload.value);
};

export async function startTrace() {
	events = [];
	session().on("Tracing.dataCollected", collect);
	await session().send("Tracing.start", {
		categories: "devtools.timeline,disabled-by-default-devtools.timeline",
		transferMode: "ReportEvents",
	});
}

export interface TraceCost {
	name: string;
	/** Milliseconds per record, summed over every event of the name. */
	ms: number;
	/** Events per record. */
	count: number;
	/** For `Layout`: layout objects marked dirty, per pass, median. */
	dirtyObjects?: number;
	/** For `Layout`: layout objects in the tree, per pass, median. */
	totalObjects?: number;
	/** For `UpdateLayoutTree`: elements whose style was recalculated, per pass, median. */
	elementCount?: number;
}

const median = (values: number[]) => {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
};

/** Ends the trace and totals complete events by name, per record. */
export async function stopTrace(records: number): Promise<TraceCost[]> {
	const done = new Promise<void>((resolve) => {
		const finish = () => {
			session().off("Tracing.tracingComplete", finish);
			resolve();
		};
		session().on("Tracing.tracingComplete", finish);
	});
	await session().send("Tracing.end");
	await done;
	session().off("Tracing.dataCollected", collect);
	const byName = new Map<
		string,
		{
			us: number;
			count: number;
			dirty: number[];
			total: number[];
			elements: number[];
		}
	>();
	for (const event of events) {
		if (event.ph !== "X" || event.dur === undefined) continue;
		const entry = byName.get(event.name) ?? {
			us: 0,
			count: 0,
			dirty: [],
			total: [],
			elements: [],
		};
		entry.us += event.dur;
		entry.count += 1;
		const begin = event.args?.beginData;
		if (begin?.dirtyObjects !== undefined) entry.dirty.push(begin.dirtyObjects);
		if (begin?.totalObjects !== undefined) entry.total.push(begin.totalObjects);
		if (event.args?.elementCount !== undefined) {
			entry.elements.push(event.args.elementCount);
		}
		byName.set(event.name, entry);
	}
	return [...byName]
		.map(([name, e]) => ({
			name,
			ms: e.us / 1000 / records,
			count: e.count / records,
			dirtyObjects: median(e.dirty),
			totalObjects: median(e.total),
			elementCount: median(e.elements),
		}))
		.sort((a, b) => b.ms - a.ms);
}
