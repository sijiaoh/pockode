import { JSONRPCErrorException } from "json-rpc-2.0";
import { type GitFailure, gitRefusalSummary } from "./gitErrors";

/**
 * Where: server/rpc/types.go's CodeCommitDraftFailed, which carries one of the
 * reasons below in `data.reason` (docs/git.md#drafting-a-commit-message). The
 * message is the server's English, with the CLI's own words for the CLI's
 * failures — shown as output, never matched on.
 */
const COMMIT_DRAFT_FAILED_CODE = -32004;

/**
 * A failed `git.commit.draft` as the commit sheet shows it, or null when there
 * is nothing to show: a cancelled draft was stopped by the user, or by the sheet
 * going away, and either way nobody is waiting to be told.
 *
 * @param agentLabel the CLI that was asked, which the sentences name — the fix
 * for a missing or signed-out CLI is that CLI's, not the workspace's.
 */
export function describeCommitDraftFailure(
	error: unknown,
	agentLabel: string,
): GitFailure | null {
	const refusal = gitRefusalSummary(error);
	if (refusal !== null) return { summary: refusal, detail: null };

	const output = error instanceof Error ? error.message : String(error);
	const failed = { summary: "Could not draft a message.", detail: output };
	if (
		!(error instanceof JSONRPCErrorException) ||
		error.code !== COMMIT_DRAFT_FAILED_CODE
	) {
		// The request itself went wrong — a dropped connection, our own clock,
		// a refused parameter. What happened is all there is to say.
		return failed;
	}

	switch (draftReason(error.data)) {
		case "cancelled":
			return null;
		case "timeout":
			return {
				summary: "Drafting took too long and was stopped.",
				detail: null,
			};
		// No link to Settings: following it would close the sheet and take the
		// message with it.
		case "cli_not_found":
			return {
				summary: `Could not draft: ${agentLabel} is not installed.`,
				detail: null,
			};
		case "auth_failed":
			return {
				summary: `Could not draft: ${agentLabel} is not signed in. Sign in under Settings → AI CLIs.`,
				detail: null,
			};
		// The staged line above updates on its own; this says why the press
		// came to nothing.
		case "nothing_staged":
			return { summary: "Nothing is staged any more.", detail: null };
		case "empty":
			return {
				summary: "The AI returned an empty message. Try again.",
				detail: null,
			};
		case "tool_use":
			return {
				summary:
					"The AI tried to use a tool, so the draft was stopped. Try again.",
				detail: null,
			};
		default:
			return failed;
	}
}

function draftReason(data: unknown): string | null {
	if (typeof data !== "object" || data === null) return null;
	const reason = (data as { reason?: unknown }).reason;
	return typeof reason === "string" ? reason : null;
}
