import type { ReactNode } from "react";
import { type FetchedOutput, fetchedOutputs } from "../../lib/toolRun";
import type { ToolRun } from "../../types/message";
import { ScrollableContent } from "../ui";

/** One labelled block of a tool call's body. */
export function Section({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="space-y-1">
			<p className="text-th-text-muted">{label}</p>
			{children}
		</div>
	);
}

/**
 * The heading of the fetched-output section.
 *
 * A count once there is more than one, and otherwise the one fetch's own
 * degenerate state — a fetch that failed or came back empty has no body worth
 * reading, so the heading is where that is said. No time in it: a history
 * record carries no timestamp, so "latest" is the only ordering anything here
 * can honestly claim.
 */
function fetchedLabel(fetched: FetchedOutput[]): string {
	if (fetched.length > 1) return `Fetched output · ${fetched.length} fetches`;
	const only = fetched[0];
	if (only.isError) return "Fetched output · fetch failed";
	if (only.isEmpty) return "Fetched output · nothing yet";
	return "Fetched output";
}

function FetchedBody({ fetched }: { fetched: FetchedOutput }) {
	if (fetched.isError) {
		// The red is here and not on the row: what failed is the call that did
		// the fetching, and the task it was reading may be running perfectly.
		return (
			<pre className="whitespace-pre-wrap font-mono text-th-error">
				{fetched.text}
			</pre>
		);
	}
	if (fetched.isEmpty) {
		return (
			<p className="text-th-text-muted">The task has produced no output yet.</p>
		);
	}
	// Not truncated: this is one record of what a later call read, not output
	// that changes every frame, and the CLI has already cut it to its own limit.
	return (
		<pre className="whitespace-pre-wrap font-mono text-th-text-muted">
			{fetched.text}
		</pre>
	);
}

/**
 * Every fetch, one block each, oldest first.
 *
 * Neither merged nor thinned to the newest: `TaskOutput` does not say whether
 * it returns the whole output or what is new since last time, and keeping only
 * the newest loses text under one reading while concatenating repeats a log
 * under the other. Separate blocks are honest under both, and cost nothing in
 * the ordinary case of a single fetch, where they collapse to no subheading at
 * all.
 */
function FetchedOutputSection({ fetched }: { fetched: FetchedOutput[] }) {
	return (
		<Section label={fetchedLabel(fetched)}>
			{fetched.length === 1 ? (
				<FetchedBody fetched={fetched[0]} />
			) : (
				<div className="space-y-2">
					{fetched.map((one, index) => (
						<div key={one.id} className="space-y-1">
							{/* Numbered by position, keyed by the fetching call: two
							    fetches of one task may well carry the same text. */}
							<p className="text-th-text-muted">Fetch {index + 1}</p>
							<FetchedBody fetched={one} />
						</div>
					))}
				</div>
			)}
		</Section>
	);
}

/**
 * What became of a call after it returned: what it handed the agent, what
 * later calls fetched of it, and how it ended.
 *
 * Shared by both renderers of a tool call, because it is one account of one
 * thing — the same reason `ToolRow` and `toolSummary` are shared. Before this,
 * `TaskItem` drew a backgrounded subagent's outcome as though it were the
 * subagent's own report and never drew the placeholder at all.
 *
 * The order is fixed and is a reading order, not a clock: what the agent read
 * first, then what was fetched, then how it ended. Nothing here has a
 * timestamp, so no other order could be claimed — and in practice this is the
 * true one.
 */
export function ToolOutcomeSections({
	run,
	outcome,
	block,
}: {
	run: ToolRun;
	/** How it ended, drawn by whichever renderer knows how. */
	outcome?: ReactNode;
	/**
	 * Draw as a block of the body rather than inline in one. `TaskItem`'s body
	 * is a stack of bordered blocks that each carry their own ceiling, while
	 * `ToolCallItem`'s is a single scroller that already has one — and a scroll
	 * area inside a scroll area swallows the drag meant for the transcript.
	 */
	block?: boolean;
}) {
	const fetched = fetchedOutputs(run);
	// Having nothing to say is the common case, and an empty block would still
	// draw its rule across the body.
	if (!run.placeholderResult && fetched.length === 0 && !outcome) return null;

	const sections = (
		<div className="space-y-3">
			{run.placeholderResult && (
				// What the agent read, kept beside the outcome below: showing only
				// the outcome would assert the agent saw something it never did.
				<Section label="Returned to the agent">
					<pre className="whitespace-pre-wrap text-th-text-muted">
						{run.placeholderResult}
					</pre>
				</Section>
			)}
			{fetched.length > 0 && <FetchedOutputSection fetched={fetched} />}
			{outcome && (
				<Section
					label={run.fromBackground ? "Outcome · after the turn" : "Result"}
				>
					{outcome}
				</Section>
			)}
		</div>
	);

	if (!block) return sections;
	return (
		<ScrollableContent className="max-h-[60vh] overflow-auto border-t border-th-border p-2">
			{sections}
		</ScrollableContent>
	);
}
