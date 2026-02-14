import { useCallback } from "react";
import { useTicketStore } from "../lib/ticketStore";
import { useWSStore } from "../lib/wsStore";
import type { Ticket, TicketListChangedNotification } from "../types/message";
import { useSubscription } from "./useSubscription";

/**
 * Manages WebSocket subscription to the ticket list.
 * Handles subscribe/unsubscribe lifecycle and notification processing.
 */
export function useTicketSubscription(enabled: boolean) {
	const ticketListSubscribe = useWSStore((s) => s.actions.ticketListSubscribe);
	const ticketListUnsubscribe = useWSStore(
		(s) => s.actions.ticketListUnsubscribe,
	);

	const setTickets = useTicketStore((s) => s.setTickets);
	const updateTickets = useTicketStore((s) => s.updateTickets);
	const reset = useTicketStore((s) => s.reset);

	const handleNotification = useCallback(
		(params: TicketListChangedNotification) => {
			updateTickets((old) => {
				switch (params.operation) {
					case "create":
						return [params.ticket, ...old];
					case "update":
						return old.map((t) =>
							t.id === params.ticket.id ? params.ticket : t,
						);
					case "delete":
						return old.filter((t) => t.id !== params.ticketId);
				}
			});
		},
		[updateTickets],
	);

	const { refresh } = useSubscription<TicketListChangedNotification, Ticket[]>(
		ticketListSubscribe,
		ticketListUnsubscribe,
		handleNotification,
		{
			enabled,
			onSubscribed: setTickets,
			onReset: reset,
		},
	);

	return { refresh };
}
