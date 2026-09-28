import type { JSONRPCRequester } from "json-rpc-2.0";

/**
 * A slash command the palette offers. Three kinds, mutually exclusive:
 * `isBuiltin` is the CLI's own, `isPockode` is one Pockode expands itself, and
 * neither is the user's custom command.
 */
export interface Command {
	name: string;
	isBuiltin: boolean;
	isPockode?: boolean;
	/** Only Pockode's commands carry one. */
	description?: string;
}

interface CommandListResult {
	commands: Command[];
}

export interface CommandActions {
	listCommands: () => Promise<Command[]>;
	invalidateCommandCache: () => void;
}

export function createCommandActions(
	getClient: () => JSONRPCRequester<void> | null,
): CommandActions {
	let cachedCommands: Command[] | null = null;

	const requireClient = (): JSONRPCRequester<void> => {
		const client = getClient();
		if (!client) {
			throw new Error("Not connected");
		}
		return client;
	};

	return {
		listCommands: async (): Promise<Command[]> => {
			if (cachedCommands) {
				return cachedCommands;
			}
			const result: CommandListResult = await requireClient().request(
				"command.list",
				{},
			);
			cachedCommands = result.commands;
			return cachedCommands;
		},
		invalidateCommandCache: () => {
			cachedCommands = null;
		},
	};
}
