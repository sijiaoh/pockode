import { create } from "zustand";

export type ToastType = "error" | "success" | "info";

export interface Toast {
	id: string;
	type: ToastType;
	message: string;
}

interface ToastState {
	toasts: Toast[];
}

export const useToastStore = create<ToastState>(() => ({
	toasts: [],
}));

export const toast = {
	show: (type: ToastType, message: string, duration = 4000) => {
		const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
		useToastStore.setState((state) => ({
			toasts: [...state.toasts, { id, type, message }],
		}));

		if (duration > 0) {
			setTimeout(() => {
				toast.dismiss(id);
			}, duration);
		}

		return id;
	},

	error: (message: string, duration?: number) =>
		toast.show("error", message, duration),

	success: (message: string, duration?: number) =>
		toast.show("success", message, duration),

	info: (message: string, duration?: number) =>
		toast.show("info", message, duration),

	dismiss: (id: string) => {
		useToastStore.setState((state) => ({
			toasts: state.toasts.filter((t) => t.id !== id),
		}));
	},

	dismissAll: () => {
		useToastStore.setState({ toasts: [] });
	},
};
