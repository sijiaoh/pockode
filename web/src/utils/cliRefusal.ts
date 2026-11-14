import type {
	AssistantMessage,
	ContentPart,
	Message,
	RecordedAccount,
} from "../types/message";

/**
 * A CLI that turned a turn away — for its credentials or for rate limits —
 * and the account it ran as, as the record says (docs/cli-profiles-ui.md#in-the-chat).
 * Everything that reads one treats the two kinds alike except for the words.
 */
export interface CliRefusal extends RecordedAccount {
	kind: "auth" | "usage_limit";
}

type Marked = Pick<AssistantMessage, "authFailure" | "usageLimit">;

/** The refusal a record carries, if it is marked as one. */
export function cliRefusalOf(record: Marked): CliRefusal | undefined {
	if (record.authFailure) return { kind: "auth", ...record.authFailure };
	if (record.usageLimit) return { kind: "usage_limit", ...record.usageLimit };
	return undefined;
}

function partRefusal(part: ContentPart): CliRefusal | undefined {
	return part.type === "warning" ? cliRefusalOf(part) : undefined;
}

/** Where a turn draws its one refusal notice. */
export interface RefusalNotice {
	refusal: CliRefusal;
	/** The warning part it is drawn on; absent: in place of the error line. */
	partIndex?: number;
}

/**
 * The turn's one refusal notice, where the refusal stands now: on its ending
 * once a marked one has failed it, and until then on the latest marked retry
 * of a turn still running. A usage limit is Claude's on a warning and then an
 * unmarked failure (the server marks the limit once), so on a failed turn the
 * notice stays on that warning.
 */
export function refusalNotice(
	message: AssistantMessage,
	isOpenTurn: boolean,
): RefusalNotice | undefined {
	if (message.status === "error") {
		const ending = cliRefusalOf(message);
		if (ending) return { refusal: ending };
	}
	const usageLimitOnly = !isOpenTurn && message.status === "error";
	if (!isOpenTurn && !usageLimitOnly) return undefined;
	for (let index = message.parts.length - 1; index >= 0; index--) {
		const refusal = partRefusal(message.parts[index]);
		if (refusal && (!usageLimitOnly || refusal.kind === "usage_limit")) {
			return { refusal, partIndex: index };
		}
	}
	return undefined;
}

/**
 * Whether a part says again what the turn's marked ending says — a retry
 * refused the same way the turn finally was — and is not drawn under it.
 */
export function isRepeatedByEnding(
	message: AssistantMessage,
	part: ContentPart,
): boolean {
	if (message.status !== "error") return false;
	const ending = cliRefusalOf(message);
	return !!ending && partRefusal(part)?.kind === ending.kind;
}

/**
 * Whether a turn failed on a refusal: a marked ending, or Claude's usage
 * limit on a warning before an unmarked one. An auth retry the turn got past
 * is not: the failure that ended it was something else.
 */
export function failedOnRefusal(message: Message): boolean {
	if (message.role !== "assistant" || message.status !== "error") return false;
	return (
		!!cliRefusalOf(message) ||
		message.parts.some((part) => partRefusal(part)?.kind === "usage_limit")
	);
}

// Per message object: the reducer replaces a message it changes rather than
// editing it (as `MessageItem`'s memo relies on too), so a streamed delta
// rescans only the turn it reached, not the whole transcript.
const marksOf = new WeakMap<Message, readonly CliRefusal[]>();

function marks(message: Message): readonly CliRefusal[] {
	let found = marksOf.get(message);
	if (found === undefined) {
		found = [];
		if (message.role === "assistant") {
			const ending = cliRefusalOf(message);
			found = [
				...(ending ? [ending] : []),
				...message.parts.flatMap((part) => partRefusal(part) ?? []),
			];
		}
		marksOf.set(message, found);
	}
	return found;
}

/**
 * Every account the transcript's refusal marks name, once each — a superset
 * of the turns that draw a notice (a retry the turn got past is marked too).
 * Empty when no turn carries a mark.
 */
export function refusalAccounts(
	messages: readonly Message[],
): RecordedAccount[] {
	const seen = new Map<string, RecordedAccount>();
	for (const message of messages) {
		for (const { agent, profileId } of marks(message)) {
			const key = `${agent}\u0000${profileId ?? "\u0001"}`;
			if (!seen.has(key)) seen.set(key, { agent, profileId });
		}
	}
	return [...seen.values()];
}
