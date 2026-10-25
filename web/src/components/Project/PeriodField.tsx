import { useEffect, useId, useState } from "react";
import { useDeviceTimeZone } from "../../hooks/useDeviceTimeZone";
import { useHasPassed } from "../../hooks/useHasPassed";
import {
	DEFAULT_PERIOD,
	describePeriod,
	HOURLY_EVERY,
	isKnownPeriod,
	LAST_DAY,
	ordinal,
	WEEK_DAYS,
} from "../../lib/schedulePeriod";
import {
	parseWallClock,
	sameZone,
	wallClock,
	zonedInstant,
	zoneLine,
} from "../../lib/scheduleZone";
import type { HourlyEvery, Period } from "../../types/schedule";
import { dayShortName, formatClock, pad2 } from "../../utils/dateTime";
import { inputClass } from "../ui/inputClass";

const MODES = ["once", "hourly", "daily", "weekly", "monthly"] as const;
type Mode = (typeof MODES)[number];

const MODE_LABEL: Record<Mode, string> = {
	once: "Once",
	hourly: "Hourly",
	daily: "Daily",
	weekly: "Weekly",
	monthly: "Monthly",
};

/** 1st … 30th, then `Last day`: what the 31st means to anyone who picks it. */
const MONTH_DAYS = Array.from({ length: LAST_DAY }, (_, i) => i + 1);

/**
 * Every input of every mode, kept across mode switches so that what carries
 * from one mode to another is already there. The minute, the time and the
 * date are the inputs' own text, so a half-typed value stays as typed.
 */
interface Inputs {
	mode: Mode;
	every: HourlyEvery;
	minute: string;
	time: string;
	days: number[];
	day: number;
	/** `null` until Once is first opened, which fills it then (§6.1). */
	date: string | null;
}

const DEFAULTS: Omit<Inputs, "mode"> = {
	every: 1,
	minute: "00",
	time: "09:00",
	days: [1],
	day: 1,
	date: null,
};

function initialInputs(period: Period): Inputs {
	switch (period.kind) {
		case "once": {
			const [date, time] = period.at.split("T");
			return { ...DEFAULTS, mode: "once", date, time: time ?? "" };
		}
		case "hourly":
			return {
				...DEFAULTS,
				mode: "hourly",
				every: period.every ?? 1,
				minute: pad2(period.minute ?? 0),
			};
		case "daily":
			return { ...DEFAULTS, mode: "daily", time: period.time };
		case "weekly":
			return {
				...DEFAULTS,
				mode: "weekly",
				time: period.time,
				days: period.weekdays,
			};
		case "monthly":
			return {
				...DEFAULTS,
				mode: "monthly",
				time: period.time,
				day: period.day,
			};
	}
}

function parseMinute(text: string): number | null {
	if (!/^\d{1,2}$/.test(text)) return null;
	const n = Number(text);
	return n <= 59 ? n : null;
}

const isTime = (text: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(text);
// A real calendar date: a browser without a date picker leaves a text field,
// where 31 February can be typed.
const isDate = (text: string | null): text is string =>
	text !== null &&
	/^\d{4}-\d{2}-\d{2}$/.test(text) &&
	parseWallClock(`${text}T00:00`) !== null;

/**
 * The date on which `time` next comes round in `zone`: today if it is still
 * ahead there, else tomorrow — so a Daily switched to Once is ready to save.
 */
function nextOccurrence(time: string, zone: string, now: number): string {
	const today = wallClock(new Date(now), zone);
	const dateOf = (offsetDays: number) => {
		const d = new Date(
			Date.UTC(today.year, today.month, today.day + offsetDays),
		);
		return d.toISOString().slice(0, 10);
	};
	const instant = zonedInstant(`${dateOf(0)}T${time}`, zone);
	return instant === null || instant > now ? dateOf(0) : dateOf(1);
}

/** Moves the inputs to another mode, carrying what carries (§6.1). */
function switchMode(
	inputs: Inputs,
	mode: Mode,
	zone: string,
	now: number,
): Inputs {
	let next: Inputs = { ...inputs, mode };
	if (mode === "hourly" && inputs.mode !== "hourly" && isTime(inputs.time)) {
		next.minute = inputs.time.slice(3);
	}
	if (mode !== "hourly" && inputs.mode === "hourly") {
		next.time = formatClock(9, parseMinute(inputs.minute) ?? 0);
	}
	if (mode === "once" && next.date === null) {
		next = {
			...next,
			date: nextOccurrence(isTime(next.time) ? next.time : "09:00", zone, now),
		};
	}
	return next;
}

type Spelled = { period: Period } | { hint: string; passed?: true };

/**
 * The period the inputs spell, or the hint naming the first thing missing
 * (docs/schedule-ui.md §6.2). A one-time must still be ahead in the schedule's
 * zone; a zone the browser does not know cannot be judged, and is the
 * server's to refuse.
 */
function spell(inputs: Inputs, zone: string, now: number): Spelled {
	const time = isTime(inputs.time) ? inputs.time : null;
	switch (inputs.mode) {
		case "once": {
			if (!isDate(inputs.date)) return { hint: "Pick a date." };
			if (!time) return { hint: "Pick a time." };
			const at = `${inputs.date}T${time}`;
			const instant = zonedInstant(at, zone);
			if (instant !== null && instant <= now) {
				return {
					hint: "That time has passed. Pick a later one.",
					passed: true,
				};
			}
			return { period: { kind: "once", at } };
		}
		case "hourly": {
			const minute = parseMinute(inputs.minute);
			return minute === null
				? { hint: "Enter a minute from 0 to 59." }
				: { period: { kind: "hourly", every: inputs.every, minute } };
		}
		case "daily":
			return time
				? { period: { kind: "daily", time } }
				: { hint: "Pick a time." };
		case "weekly": {
			if (inputs.days.length === 0) return { hint: "Pick at least one day." };
			if (!time) return { hint: "Pick a time." };
			const weekdays = [...new Set(inputs.days)].sort((a, b) => a - b);
			// One period, one spelling: every day is daily, as the server stores it.
			return {
				period:
					weekdays.length === 7
						? { kind: "daily", time }
						: { kind: "weekly", weekdays, time },
			};
		}
		case "monthly":
			return time
				? { period: { kind: "monthly", day: inputs.day, time } }
				: { hint: "Pick a time." };
	}
}

interface Props {
	/** The stored period, or `null` for a new schedule. Read once, on mount. */
	initial: Period | null;
	/**
	 * Called on every edit — never on mount — with the period the inputs now
	 * spell, or `null` while they spell nothing yet; and with `null` again if
	 * an edited one-time's time passes while the field is open. Whether that
	 * is a change is the caller's comparison (`samePeriod`).
	 */
	onChange: (period: Period | null) => void;
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
 * the field's own state after that: it is never re-derived from the period
 * being written, so ticking the seventh day — which writes a daily period —
 * does not swap the day toggles out from under the user.
 */
export default function PeriodField({ initial, onChange, timeZone }: Props) {
	const id = useId();
	const deviceZone = useDeviceTimeZone();
	const zone = timeZone ?? deviceZone;
	// A kind from a newer server opens on the default; nothing is sent until saved.
	const unsupported = initial !== null && !isKnownPeriod(initial);
	// No kind at all is a schedule stored before periods had kinds, not one
	// from a newer server.
	const unreadable = unsupported && !initial.kind;
	const [inputs, setInputs] = useState(() =>
		initialInputs(initial && !unsupported ? initial : DEFAULT_PERIOD),
	);
	const [touched, setTouched] = useState(false);

	const now = Date.now();
	const spelled = spell(inputs, zone, now);

	// Judged again when a one-time's own minute arrives, so a field left open
	// across it goes to the hint rather than offering a Save that is refused.
	const onceInstant =
		inputs.mode === "once" && isDate(inputs.date) && isTime(inputs.time)
			? zonedInstant(`${inputs.date}T${inputs.time}`, zone)
			: null;
	useHasPassed(onceInstant);

	const passed = "passed" in spelled;
	useEffect(() => {
		if (touched && passed) onChange(null);
	}, [touched, passed, onChange]);

	const update = (next: Inputs) => {
		setInputs(next);
		setTouched(true);
		const result = spell(next, zone, Date.now());
		onChange("period" in result ? result.period : null);
	};

	const toggleDay = (day: number) => {
		const days = inputs.days.includes(day)
			? inputs.days.filter((d) => d !== day)
			: [...inputs.days, day];
		update({ ...inputs, days });
	};

	const fieldClass = `min-h-[44px] rounded-lg bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary ${inputClass}`;
	const labelClass = "text-sm text-th-text-secondary";

	const timeInput = (label: string) => (
		<>
			<label htmlFor={`${id}-time`} className={labelClass}>
				{label}
			</label>
			<input
				id={`${id}-time`}
				type="time"
				value={inputs.time}
				onChange={(e) => update({ ...inputs, time: e.target.value })}
				className={fieldClass}
			/>
		</>
	);

	return (
		<div className="space-y-3">
			<div className="space-y-1.5">
				{/* Uppercase, as the segmented control it replaced labelled itself:
				    the detail page lets this stand in for its section heading. */}
				<label
					htmlFor={`${id}-mode`}
					className="block text-xs font-medium uppercase text-th-text-muted"
				>
					Period
				</label>
				{/* A select, not a segmented control: five segments do not fit a
				    320px sheet, and a phone opens its own picker for it. */}
				<select
					id={`${id}-mode`}
					value={inputs.mode}
					// Picking the mode already shown is not an edit.
					onChange={(e) => {
						const mode = e.target.value as Mode;
						if (mode !== inputs.mode) {
							update(switchMode(inputs, mode, zone, Date.now()));
						}
					}}
					className={`w-full ${fieldClass}`}
				>
					{MODES.map((mode) => (
						<option key={mode} value={mode}>
							{MODE_LABEL[mode]}
						</option>
					))}
				</select>
			</div>

			{inputs.mode === "once" && (
				// Wrapping, so on the narrowest phones the time drops under the
				// date rather than either shrinking.
				<div className="flex flex-wrap items-center gap-2">
					<span className="flex items-center gap-2">
						<label htmlFor={`${id}-date`} className={labelClass}>
							On
						</label>
						<input
							id={`${id}-date`}
							type="date"
							value={inputs.date ?? ""}
							onChange={(e) => update({ ...inputs, date: e.target.value })}
							className={fieldClass}
						/>
					</span>
					<span className="flex items-center gap-2">{timeInput("at")}</span>
				</div>
			)}

			{inputs.mode === "hourly" && (
				<div className="flex flex-wrap items-center gap-2">
					<label htmlFor={`${id}-every`} className={labelClass}>
						Every
					</label>
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
								{n === 1 ? "1 hour" : `${n} hours`}
							</option>
						))}
					</select>
					<label htmlFor={`${id}-minute`} className={labelClass}>
						at minute
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

			{inputs.mode === "daily" && (
				<div className="flex items-center gap-2">{timeInput("At")}</div>
			)}

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
					<div className="flex items-center gap-2">{timeInput("At")}</div>
				</>
			)}

			{inputs.mode === "monthly" && (
				<div className="flex flex-wrap items-center gap-2">
					<label htmlFor={`${id}-day`} className={labelClass}>
						On the
					</label>
					<select
						id={`${id}-day`}
						value={inputs.day}
						onChange={(e) => update({ ...inputs, day: Number(e.target.value) })}
						className={fieldClass}
					>
						{MONTH_DAYS.map((day) => (
							<option key={day} value={day}>
								{day === LAST_DAY ? "Last day" : ordinal(day)}
							</option>
						))}
					</select>
					{timeInput("at")}
				</div>
			)}

			<div className="text-xs text-th-text-muted">
				<p>
					{"period" in spelled
						? describePeriod(spelled.period, zone)
						: spelled.hint}
				</p>
				{/* Only for the two days some months lack; the 31st is `Last day`. */}
				{inputs.mode === "monthly" &&
					(inputs.day === 29 || inputs.day === 30) && (
						<p>In shorter months, runs on the last day.</p>
					)}
				{/* Its own line, not joined with ` · `: a phone would wrap the
				    joined form mid-sentence. */}
				{timeZone !== undefined && !sameZone(timeZone, deviceZone) && (
					<p>{zoneLine(timeZone, deviceZone)}</p>
				)}
				{unsupported && (
					<p>
						{unreadable
							? "This period could not be read. Saving replaces it."
							: "This period was set by a newer version of Pockode. Saving replaces it."}
					</p>
				)}
			</div>
		</div>
	);
}
