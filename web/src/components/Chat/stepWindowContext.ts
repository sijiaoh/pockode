import { createContext, useContext } from "react";
import { stepWindowLines } from "../../lib/subagentRun";
import type { ToolRun } from "../../types/message";

/**
 * How many step-window lines each subagent row of a list gets, by its call
 * (`stepWindowLines`). The list provides it: the size and whether a settled row
 * keeps its frozen window both depend on the row's siblings, which a row
 * cannot see.
 */
export const StepWindowContext = createContext<ReadonlyMap<
	string,
	number
> | null>(null);

/**
 * This row's window lines. A row outside a list is a list of one.
 */
export function useStepWindowLines(rowRun: ToolRun): number {
	const lines = useContext(StepWindowContext);
	return (lines ?? stepWindowLines([rowRun])).get(rowRun.id) ?? 0;
}
