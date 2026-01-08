import type { JSONRPCClient } from "json-rpc-2.0";

export interface Command {
	name: string;
	isBuiltin: boolean;
}

interface CommandListResult {
	commands: Command[];
}

export interface CommandActions {
	listCommands: () => Promise<Command[]>;
	invalidateCommandCache: () => void;
}

export function createCommandActions(
	getClient: () => JSONRPCClient | null,
): CommandActions {
	let cachedCommands: Command[] | null = null;

	const requireClient = (): JSONRPCClient => {
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
