import { useMemo } from "react";
import { groupTicketsByStatus, useTicketStore } from "../lib/ticketStore";
import { useTicketSubscription } from "./useTicketSubscription";

/**
 * Hook to access tickets with automatic subscription management.
 * Returns tickets grouped by status for kanban display.
 */
export function useTickets(enabled: boolean) {
	const tickets = useTicketStore((s) => s.tickets);
	const isLoading = useTicketStore((s) => s.isLoading);
	const isSuccess = useTicketStore((s) => s.isSuccess);

	const { refresh } = useTicketSubscription(enabled);

	const grouped = useMemo(() => groupTicketsByStatus(tickets), [tickets]);

	return {
		tickets,
		grouped,
		isLoading,
		isSuccess,
		refresh,
	};
}
