import type { JSONRPCRequester } from "json-rpc-2.0";
import type {
	Ticket,
	TicketCreateParams,
	TicketDeleteParams,
	TicketListSubscribeResult,
	TicketStartParams,
	TicketStartResult,
	TicketStatus,
	TicketUpdateParams,
} from "../../types/message";

export interface TicketActions {
	createTicket: (params: TicketCreateParams) => Promise<Ticket>;
	updateTicket: (
		ticketId: string,
		updates: { title?: string; description?: string; status?: TicketStatus },
	) => Promise<Ticket>;
	deleteTicket: (ticketId: string) => Promise<void>;
	startTicket: (ticketId: string) => Promise<TicketStartResult>;
	ticketListSubscribe: (
		onNotification: (params: unknown) => void,
	) => Promise<TicketListSubscribeResult>;
	ticketListUnsubscribe: (id: string) => Promise<void>;
}

export function createTicketActions(
	getClient: () => JSONRPCRequester<void> | null,
	registerCallback: (id: string, callback: (params: unknown) => void) => void,
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
			updates: { title?: string; description?: string; status?: TicketStatus },
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
			onNotification: (params: unknown) => void,
		): Promise<TicketListSubscribeResult> => {
			const result: TicketListSubscribeResult = await requireClient().request(
				"ticket.list.subscribe",
				{},
			);
			registerCallback(result.id, onNotification);
			return result;
		},

		ticketListUnsubscribe: async (id: string): Promise<void> => {
			unregisterCallback(id);
			await requireClient().request("ticket.list.unsubscribe", { id });
		},
	};
}
