import { JSONRPCErrorException } from "json-rpc-2.0";

/**
 * Where: server/rpc/types.go's CodeGitBusy. The server answers with it when an
 * operation this one would collide with already holds the worktree and the two
 * seconds it waits were not enough. Which operations collide is the server's
 * business (server/git/lock.go), and it is narrower than "any two": a fetch
 * never stops a file from being staged, while a checkout does.
 *
 * The refusal is recognised by this code and never by its sentence: the
 * message is English prose the server is free to reword, and a git command that
 * actually ran and failed comes back as an internal error with git's own text.
 */
const GIT_BUSY_CODE = -32001;

/**
 * The operations the server names in a refusal, each as the gerund that goes
 * after "busy". The keys are the contract (server/git/lock.go); the values are
 * the only part a user reads, so they say what the panel calls the action
 * rather than what the RPC is called.
 */
const BUSY_OPERATIONS: Record<string, string> = {
	stage: "staging files",
	unstage: "unstaging files",
	discard: "discarding changes",
	commit: "committing",
	checkout: "switching branches",
	"branch-create": "creating a branch",
	fetch: "fetching",
	pull: "pulling",
	push: "pushing",
};

/** How a failed git request is shown: a sentence, and git's own words if any. */
export interface GitFailure {
	/** One line of plain language. */
	summary: string;
	/**
	 * git's output, shown verbatim beneath the summary — null when git never
	 * ran, which is the whole difference a refusal makes.
	 */
	detail: string | null;
}

/**
 * The plain-language sentence for a refused request, or null if the failure is
 * anything else.
 *
 * Exported for the two sheets that put the sentence inside one of their own,
 * naming the branch the refusal cannot name; anything that renders a failure
 * as it comes wants describeGitFailure.
 */
export function gitBusySummary(error: unknown): string | null {
	if (
		!(error instanceof JSONRPCErrorException) ||
		error.code !== GIT_BUSY_CODE
	) {
		return null;
	}

	// An operation the server has since added is still a refusal worth
	// explaining; only the clause naming it is dropped.
	const doing = BUSY_OPERATIONS[busyOperation(error.data) ?? ""];
	return doing
		? `This worktree is busy ${doing}. Try again once it finishes.`
		: "This worktree is busy with another git operation. Try again once it finishes.";
}

function busyOperation(data: unknown): string | null {
	if (typeof data !== "object" || data === null) return null;
	const operation = (data as { operation?: unknown }).operation;
	return typeof operation === "string" ? operation : null;
}

/**
 * A failed git request as the panel shows it, keeping the two kinds of failure
 * apart: a refusal is the server's own sentence about a request that never ran,
 * while everything else is git failing and gets its output quoted verbatim —
 * the reader is a developer who needs git's words, not a paraphrase of them.
 *
 * @param summarize turns git's own message into one line of plain language.
 */
export function describeGitFailure(
	error: unknown,
	summarize: (detail: string) => string,
): GitFailure {
	const busy = gitBusySummary(error);
	if (busy !== null) return { summary: busy, detail: null };

	const detail = error instanceof Error ? error.message : String(error);
	return { summary: summarize(detail), detail };
}
