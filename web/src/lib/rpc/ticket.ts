import type { JSONRPCRequester } from "json-rpc-2.0";
import type {
	Ticket,
	TicketCreateParams,
	TicketDeleteParams,
	TicketListChangedNotification,
	TicketStartParams,
	TicketStartResult,
	TicketStatus,
	TicketUpdateParams,
	WatchSubscribeResult,
} from "../../types/message";

export interface TicketActions {
	createTicket: (params: TicketCreateParams) => Promise<Ticket>;
	updateTicket: (
		ticketId: string,
		updates: {
			title?: string;
			description?: string;
			status?: TicketStatus;
			priority?: number;
		},
	) => Promise<Ticket>;
	deleteTicket: (ticketId: string) => Promise<void>;
	startTicket: (ticketId: string) => Promise<TicketStartResult>;
	ticketListSubscribe: (
		onNotification: (params: TicketListChangedNotification) => void,
	) => Promise<WatchSubscribeResult<Ticket[]>>;
	ticketListUnsubscribe: (id: string) => Promise<void>;
}

export function createTicketActions(
	getClient: () => JSONRPCRequester<void> | null,
	registerCallback: (
		id: string,
		callback: (params: TicketListChangedNotification) => void,
	) => void,
	unregisterCallback: (id: string) => void,
): TicketActions {
	const requireClient = (): JSONRPCRequester<void> => {
		const client = getClient();
		if (!client) {
			throw new Error("Not connected");
		}
		return client;
	};

	return {
		createTicket: async (params: TicketCreateParams): Promise<Ticket> => {
			return requireClient().request("ticket.create", params);
		},

		updateTicket: async (
			ticketId: string,
			updates: {
				title?: string;
				description?: string;
				status?: TicketStatus;
				priority?: number;
			},
		): Promise<Ticket> => {
			return requireClient().request("ticket.update", {
				ticket_id: ticketId,
				...updates,
			} as TicketUpdateParams);
		},

		deleteTicket: async (ticketId: string): Promise<void> => {
			await requireClient().request("ticket.delete", {
				ticket_id: ticketId,
			} as TicketDeleteParams);
		},

		startTicket: async (ticketId: string): Promise<TicketStartResult> => {
			return requireClient().request("ticket.start", {
				ticket_id: ticketId,
			} as TicketStartParams);
		},

		ticketListSubscribe: async (
			onNotification: (params: TicketListChangedNotification) => void,
		): Promise<WatchSubscribeResult<Ticket[]>> => {
			const result = (await requireClient().request(
				"ticket.list.subscribe",
				{},
			)) as { id: string; tickets: Ticket[] };
			registerCallback(result.id, onNotification);
			return { id: result.id, initial: result.tickets };
		},

		ticketListUnsubscribe: async (id: string): Promise<void> => {
			unregisterCallback(id);
			await requireClient().request("ticket.list.unsubscribe", { id });
		},
	};
}
