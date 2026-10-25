import { useId, useState } from "react";
import { useDeviceTimeZone } from "../../hooks/useDeviceTimeZone";
import {
	cronFields,
	DEFAULT_CRON,
	dayShortName,
	describePreset,
	formatClock,
	HOURLY_EVERY,
	type HourlyEvery,
	type Period,
	parsePeriod,
	toCron,
	WEEK_DAYS,
} from "../../lib/schedulePeriod";
import { sameZone, zoneLine } from "../../lib/scheduleZone";
import { inputClass } from "../ui/inputClass";
import ToggleGroup from "../ui/ToggleGroup";

const MODES = ["hourly", "daily", "weekly", "custom"] as const;
type Mode = (typeof MODES)[number];

const MODE_LABEL: Record<Mode, string> = {
	hourly: "Hourly",
	daily: "Daily",
	weekly: "Weekly",
	custom: "Custom",
};

/**
 * Every input of every mode, kept across mode switches so that what carries
 * from one mode to another is already there. The minute and the time are the
 * inputs' own text, so a half-typed value stays as typed.
 */
interface Inputs {
	mode: Mode;
	every: HourlyEvery;
	minute: string;
	time: string;
	days: number[];
	custom: string;
}

const DEFAULTS: Omit<Inputs, "mode" | "custom"> = {
	every: 1,
	minute: "00",
	time: "09:00",
	days: [1],
};

/** `base` with what `period` names written over it; the rest is kept. */
function withPeriod<T extends Omit<Inputs, "mode" | "custom">>(
	base: T,
	period: Period,
): T {
	if (period.kind === "hourly") {
		return {
			...base,
			every: period.every,
			minute: String(period.minute).padStart(2, "0"),
		};
	}
	const time = formatClock(period.hour, period.minute);
	return period.kind === "weekly"
		? { ...base, time, days: period.days }
		: { ...base, time };
}

function initialInputs(initial: string): Inputs {
	const stored = initial.trim() === "" ? DEFAULT_CRON : initial;
	const period = parsePeriod(stored);
	if (!period) return { ...DEFAULTS, mode: "custom", custom: stored.trim() };
	return { ...withPeriod(DEFAULTS, period), mode: period.kind, custom: "" };
}

function parseMinute(text: string): number | null {
	if (!/^\d{1,2}$/.test(text)) return null;
	const n = Number(text);
	return n <= 59 ? n : null;
}

function parseTime(text: string): { hour: number; minute: number } | null {
	const match = /^(\d{2}):(\d{2})$/.exec(text);
	if (!match) return null;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/** The preset the inputs spell, or `null` while they spell nothing yet. */
function presetOf(inputs: Inputs): Period | null {
	switch (inputs.mode) {
		case "hourly": {
			const minute = parseMinute(inputs.minute);
			return minute === null
				? null
				: { kind: "hourly", every: inputs.every, minute };
		}
		case "daily": {
			const time = parseTime(inputs.time);
			return time && { kind: "daily", ...time };
		}
		case "weekly": {
			const time = parseTime(inputs.time);
			return time && inputs.days.length > 0
				? { kind: "weekly", days: inputs.days, ...time }
				: null;
		}
		case "custom":
			return null;
	}
}

/**
 * The cron the inputs spell. For Custom only the field count is checked;
 * everything else is the server's parser's to judge (docs/schedule-ui.md §6.3).
 */
function cronOf(inputs: Inputs): string | null {
	if (inputs.mode === "custom") {
		const text = inputs.custom.trim();
		return text !== "" && cronFields(text).length === 5 ? text : null;
	}
	const preset = presetOf(inputs);
	return preset && toCron(preset);
}

/** Moves the inputs to another mode, carrying what carries (§6.1). */
function switchMode(inputs: Inputs, mode: Mode): Inputs {
	if (mode === "custom") {
		return { ...inputs, mode, custom: cronOf(inputs) ?? inputs.custom };
	}
	let from = inputs;
	if (inputs.mode === "custom") {
		const parsed = parsePeriod(inputs.custom);
		if (!parsed) return { ...inputs, ...DEFAULTS, mode };
		from = { ...withPeriod(inputs, parsed), mode: parsed.kind };
		// Typed text that means every day ticks every day; the days ticked
		// before are not what it says.
		if (parsed.kind === "daily") from.days = [...WEEK_DAYS];
	}
	if (mode === "hourly" && from.mode !== "hourly") {
		const time = parseTime(from.time);
		return {
			...from,
			mode,
			minute: time ? String(time.minute).padStart(2, "0") : from.minute,
		};
	}
	if (mode !== "hourly" && from.mode === "hourly") {
		const minute = parseMinute(from.minute);
		return {
			...from,
			mode,
			time: formatClock(9, minute ?? 0),
		};
	}
	return { ...from, mode };
}

interface Props {
	/** A stored cron, or `""` for a new schedule. Read once, on mount. */
	initial: string;
	/**
	 * Called on every edit — never on mount — with the cron the inputs now
	 * spell, or `null` while they spell nothing yet. Whether that is a change
	 * is the caller's comparison with the stored string.
	 */
	onChange: (cron: string | null) => void;
	/**
	 * The stored schedule's zone, which every input is typed in. Absent for a
	 * new schedule, which is made in the device's zone and so needs no line.
	 * The field never writes a zone: editing keeps the schedule's.
	 */
	timeZone?: string;
}

/**
 * The one period editor, in the create sheet and on the detail page
 * (docs/schedule-ui.md §6.1). The mode is picked from `initial` once and is
 * the field's own state after that: it is never re-derived from the cron
 * being written, so ticking the seventh day — which writes a daily cron —
 * does not swap the day toggles out from under the user.
 */
export default function PeriodField({ initial, onChange, timeZone }: Props) {
	const id = useId();
	const deviceZone = useDeviceTimeZone();
	const [inputs, setInputs] = useState(() => initialInputs(initial));

	const update = (next: Inputs) => {
		setInputs(next);
		onChange(cronOf(next));
	};

	const toggleDay = (day: number) => {
		const days = inputs.days.includes(day)
			? inputs.days.filter((d) => d !== day)
			: [...inputs.days, day];
		update({ ...inputs, days });
	};

	const fieldClass = `min-h-[44px] rounded-lg bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary ${inputClass}`;

	const timeInput = (
		<div className="flex items-center gap-2">
			<label htmlFor={`${id}-time`} className="text-sm text-th-text-secondary">
				At
			</label>
			<input
				id={`${id}-time`}
				type="time"
				value={inputs.time}
				onChange={(e) => update({ ...inputs, time: e.target.value })}
				className={fieldClass}
			/>
		</div>
	);

	let description: string;
	if (inputs.mode === "custom") {
		const parsed = parsePeriod(inputs.custom);
		description = parsed
			? describePreset(parsed)
			: "Checked by the server when you save.";
	} else if (inputs.mode === "weekly" && inputs.days.length === 0) {
		description = "Pick at least one day.";
	} else {
		// A preset that spells nothing keeps Save/Create disabled; say why.
		const preset = presetOf(inputs);
		description = preset
			? describePreset(preset)
			: inputs.mode === "hourly"
				? "Enter a minute from 0 to 59."
				: "Pick a time.";
	}

	return (
		<div className="space-y-3">
			<ToggleGroup<Mode>
				label="Period"
				items={MODES}
				selected={inputs.mode}
				// Re-tapping the lit mode is not an edit: it would report a cron
				// the caller reads as changed from a stored non-canonical spelling.
				onSelect={(mode) => {
					if (mode !== inputs.mode) update(switchMode(inputs, mode));
				}}
				getInfo={(mode) => ({ label: MODE_LABEL[mode] })}
			/>

			{inputs.mode === "hourly" && (
				<div className="flex flex-wrap items-center gap-2 text-sm text-th-text-secondary">
					<label htmlFor={`${id}-every`}>Every</label>
					<select
						id={`${id}-every`}
						value={inputs.every}
						onChange={(e) =>
							update({
								...inputs,
								every: Number(e.target.value) as HourlyEvery,
							})
						}
						className={fieldClass}
					>
						{HOURLY_EVERY.map((n) => (
							<option key={n} value={n}>
								{n}
							</option>
						))}
					</select>
					<label htmlFor={`${id}-minute`}>
						{inputs.every === 1 ? "hour" : "hours"} at minute
					</label>
					<input
						id={`${id}-minute`}
						type="text"
						inputMode="numeric"
						maxLength={2}
						value={inputs.minute}
						onChange={(e) => update({ ...inputs, minute: e.target.value })}
						className={`w-16 ${fieldClass}`}
					/>
				</div>
			)}

			{inputs.mode === "daily" && timeInput}

			{inputs.mode === "weekly" && (
				<>
					{/* biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not form fields to submit */}
					<div role="group" aria-label="Days" className="flex flex-wrap gap-2">
						{WEEK_DAYS.map((day) => {
							const pressed = inputs.days.includes(day);
							return (
								<button
									key={day}
									type="button"
									aria-pressed={pressed}
									onClick={() => toggleDay(day)}
									// Bordered, not filled, when off: the sheet's ground is
									// bg-secondary, so a fill would leave loose words there.
									className={`h-11 w-11 rounded-lg border text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent ${
										pressed
											? "border-th-accent bg-th-accent text-th-accent-text"
											: "border-th-border text-th-text-secondary hover:bg-th-bg-tertiary"
									}`}
								>
									{dayShortName(day)}
								</button>
							);
						})}
					</div>
					{timeInput}
				</>
			)}

			{inputs.mode === "custom" && (
				<div className="space-y-1.5">
					<input
						type="text"
						aria-label="Cron expression"
						aria-describedby={`${id}-custom-hint`}
						placeholder="minute hour day month weekday"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						value={inputs.custom}
						onChange={(e) => update({ ...inputs, custom: e.target.value })}
						className={`w-full font-mono ${fieldClass}`}
					/>
					<p id={`${id}-custom-hint`} className="text-xs text-th-text-muted">
						Standard 5-field cron, e.g. 0 9 1 * * for 09:00 on the 1st.
					</p>
				</div>
			)}

			<div className="text-xs text-th-text-muted">
				<p>{description}</p>
				{/* Its own line, not joined with ` · `: a phone would wrap the
				    joined form mid-sentence. */}
				{timeZone !== undefined && !sameZone(timeZone, deviceZone) && (
					<p>{zoneLine(timeZone, deviceZone)}</p>
				)}
			</div>
		</div>
	);
}
