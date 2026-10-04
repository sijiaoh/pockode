/**
 * How a tool call's opened body is arranged: which block comes first and what
 * the result block is called. The invocation names itself, by what it shows
 * (`invocationLabel` in ToolInvocation.tsx).
 */
export interface ToolBodyLayout {
	/**
	 * The result above the call, with the call folded. For tools whose row has
	 * already said everything that was asked — a `Read` is its path, a `Grep` its
	 * pattern — so the input in full would only stand between the reader and the
	 * answer they opened the row for.
	 */
	resultFirst: boolean;
	resultLabel: string;
	/**
	 * Whether the result is something read at length — a whole file, a diff —
	 * and so worth a screen of its own once it runs past the clamp.
	 */
	fullScreen: boolean;
	/**
	 * Whether the result is read from its end, and so clamped keeping the end in
	 * view: a test run's or a build's verdict is its last lines, not its first.
	 */
	resultFromEnd: boolean;
	/**
	 * Whether a successful result only acknowledges the call, and is left out:
	 * a `TodoWrite`'s list is its input, and its answer is a sentence telling
	 * the agent to keep using the tool. A failure still says why.
	 */
	resultIsAcknowledgement: boolean;
}

const DEFAULT_LAYOUT: ToolBodyLayout = {
	resultFirst: false,
	resultLabel: "Result",
	fullScreen: false,
	resultFromEnd: false,
	resultIsAcknowledgement: false,
};

const LAYOUTS = new Map<string, ToolBodyLayout>(
	Object.entries({
		Read: { resultFirst: true, resultLabel: "Content", fullScreen: true },
		Glob: { resultFirst: true, resultLabel: "Matches" },
		Grep: { resultFirst: true, resultLabel: "Matches" },
		WebSearch: { resultFirst: true, resultLabel: "Results" },
		TodoWrite: { resultIsAcknowledgement: true },
		// The command first: it is what has to be read before trusting the output.
		Bash: { resultLabel: "Output", resultFromEnd: true },
		WebFetch: { resultLabel: "Page" },
		Edit: { resultLabel: "Change", fullScreen: true },
		MultiEdit: { resultLabel: "Change", fullScreen: true },
		Write: { resultLabel: "Content", fullScreen: true },
	} satisfies Record<string, Partial<ToolBodyLayout>>).map(([name, layout]) => [
		name,
		{ ...DEFAULT_LAYOUT, ...layout },
	]),
);

export function toolBodyLayout(toolName: string): ToolBodyLayout {
	// A Map, not an object lookup: a tool name is the agent's string, and
	// `constructor` would find something on any plain object.
	return LAYOUTS.get(toolName) ?? DEFAULT_LAYOUT;
}
