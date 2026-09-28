import type { PockodeCommandInvocation } from "../types/message";

/**
 * The name prefix the server claims for Pockode's own commands: a message
 * starting with `/` and this prefix is expanded by the server or refused, never
 * passed to the agent. Keep in sync with `PockodePrefix` in
 * server/command/pockode.go.
 */
export const POCKODE_COMMAND_PREFIX = "pockode-";

// Go's unicode.IsSpace, which the server splits on. JS `\s` and `trim()` differ
// on two characters (U+0085 is space to Go, U+FEFF is not), and a refused
// command's echo is never corrected by a reply, so it has to split the same way.
const SPACE =
	"\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const FIRST_SPACE = new RegExp(`[${SPACE}]`);
const EDGE_SPACE = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "g");

/**
 * Splits a message invoking a Pockode command the way the server does, so the
 * local echo can draw the command row before the server has answered. Whether
 * the name is a known command is the server's to say.
 */
export function parsePockodeCommand(
	content: string,
): PockodeCommandInvocation | null {
	if (!content.startsWith(`/${POCKODE_COMMAND_PREFIX}`)) return null;
	const rest = content.slice(1);
	const space = rest.search(FIRST_SPACE);
	if (space === -1) return { name: rest };
	const name = rest.slice(0, space);
	const args = rest.slice(space).replace(EDGE_SPACE, "");
	return args ? { name, args } : { name };
}

/** The command as the user would type it again. */
export function formatPockodeCommand(
	command: PockodeCommandInvocation,
): string {
	return command.args ? `/${command.name} ${command.args}` : `/${command.name}`;
}
