import { create } from "zustand";
import type { Ticket } from "../types/message";

interface TicketState {
	tickets: Ticket[];
	isLoading: boolean;
	isSuccess: boolean;
}

interface TicketActions {
	setTickets: (tickets: Ticket[]) => void;
	updateTickets: (updater: (old: Ticket[]) => Ticket[]) => void;
	reset: () => void;
}

export type TicketStore = TicketState & TicketActions;

export const useTicketStore = create<TicketStore>((set) => ({
	tickets: [],
	isLoading: true,
	isSuccess: false,
	setTickets: (tickets) => set({ tickets, isLoading: false, isSuccess: true }),
	updateTickets: (updater) =>
		set((state) => ({ tickets: updater(state.tickets) })),
	reset: () => set({ tickets: [], isLoading: false, isSuccess: false }),
}));

/**
 * Get tickets grouped by status for kanban display.
 * - open: sorted by priority (lower = higher priority)
 * - in_progress/done: sorted by updated_at descending
 */
export function groupTicketsByStatus(
	tickets: Ticket[],
): Record<Ticket["status"], Ticket[]> {
	const open = tickets
		.filter((t) => t.status === "open")
		.sort((a, b) => a.priority - b.priority);

	const in_progress = tickets
		.filter((t) => t.status === "in_progress")
		.sort(
			(a, b) =>
				new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
		);

	const done = tickets
		.filter((t) => t.status === "done")
		.sort(
			(a, b) =>
				new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
		);

	return { open, in_progress, done };
}
