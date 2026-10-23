import type { JSONRPCRequester } from "json-rpc-2.0";
import type {
	Schedule,
	ScheduleCreateParams,
	ScheduleUpdateParams,
} from "../../types/schedule";
import type { Work } from "../../types/work";
import { requireClient } from "./client";

export interface ScheduleActions {
	createSchedule: (params: ScheduleCreateParams) => Promise<Schedule>;
	updateSchedule: (params: ScheduleUpdateParams) => Promise<void>;
	deleteSchedule: (id: string) => Promise<void>;
	/** Makes and starts a run now, enabled or not; answers with the started job. */
	runSchedule: (id: string) => Promise<Work>;
}

export function createScheduleActions(
	getClient: () => JSONRPCRequester<void> | null,
): ScheduleActions {
	const client = () => requireClient(getClient);

	return {
		createSchedule: async (params: ScheduleCreateParams): Promise<Schedule> => {
			return client().request("schedule.create", params);
		},
		updateSchedule: async (params: ScheduleUpdateParams): Promise<void> => {
			await client().request("schedule.update", params);
		},
		deleteSchedule: async (id: string): Promise<void> => {
			await client().request("schedule.delete", { id });
		},
		runSchedule: async (id: string): Promise<Work> => {
			return client().request("schedule.run", { id });
		},
	};
}
