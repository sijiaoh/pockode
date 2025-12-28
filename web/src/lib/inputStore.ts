import { create } from "zustand";

interface InputState {
	inputs: Record<string, string>;
}

export const useInputStore = create<InputState>(() => ({
	inputs: {},
}));

export const inputActions = {
	set: (sessionId: string, content: string) =>
		useInputStore.setState((state) => ({
			inputs: { ...state.inputs, [sessionId]: content },
		})),
	clear: (sessionId: string) =>
		useInputStore.setState((state) => {
			const { [sessionId]: _, ...rest } = state.inputs;
			return { inputs: rest };
		}),
};
