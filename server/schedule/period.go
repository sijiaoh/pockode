package schedule

import (
	"errors"
	"fmt"
	"slices"
	"sort"
	"time"
)

// PeriodKind is the shape of a period. The set is closed on purpose: these are
// the periods people ask for, and a rule outside them is unsupported until
// someone needs it rather than written in a general rule language.
type PeriodKind string

const (
	// PeriodOnce fires once, at At, and then never again.
	PeriodOnce PeriodKind = "once"
	// PeriodHourly fires every Every hours, counted from midnight, at Minute.
	PeriodHourly PeriodKind = "hourly"
	// PeriodDaily fires every day at Time.
	PeriodDaily PeriodKind = "daily"
	// PeriodWeekly fires at Time on each of Weekdays.
	PeriodWeekly PeriodKind = "weekly"
	// PeriodMonthly fires at Time on day Day of every month, or on the month's
	// last day when it is shorter.
	PeriodMonthly PeriodKind = "monthly"
)

// Period says when a schedule fires. Every time in it is a wall-clock reading
// in the schedule's TimeZone. Only the fields of its Kind may be set, so one
// period has one spelling; the store keeps it in the canonical form
// normalize returns.
type Period struct {
	Kind PeriodKind `json:"kind"`
	// At is a once period's date and time, "2006-01-02T15:04".
	At string `json:"at,omitempty"`
	// Every is an hourly period's interval in hours: a divisor of 24, so the
	// firings are evenly spaced across midnight too. Absent means 1.
	Every int `json:"every,omitempty"`
	// Minute is an hourly period's minute past the hour, 0-59.
	Minute int `json:"minute,omitempty"`
	// Time is the "15:04" a daily, weekly or monthly period fires at.
	Time string `json:"time,omitempty"`
	// Weekdays are a weekly period's days, 0 (Sunday) to 6 (Saturday) as
	// time.Weekday and JavaScript's getDay count them; ascending, no repeats,
	// fewer than seven — all seven is daily.
	Weekdays []int `json:"weekdays,omitempty"`
	// Day is a monthly period's day of the month, 1-31. A month without that
	// day fires on its last one, so 31 means "the last day of every month"
	// rather than "the months that have a 31st".
	Day int `json:"day,omitempty"`
}

const (
	periodAtLayout   = "2006-01-02T15:04"
	periodTimeLayout = "15:04"
)

// hourlyIntervals are the intervals an hourly period takes. An interval that
// does not divide 24 would leave a shorter gap at midnight every day than the
// one its name promises.
var hourlyIntervals = []int{1, 2, 3, 4, 6, 8, 12}

// rule is a validated Period, ready to compute firings from.
type rule struct {
	kind         PeriodKind
	at           time.Time // once; a UTC time standing for a wall-clock reading
	every        int       // hourly
	hour, minute int
	weekdays     [7]bool // weekly
	day          int     // monthly
}

func (p Period) equal(q Period) bool {
	return p.Kind == q.Kind && p.At == q.At && p.Every == q.Every && p.Minute == q.Minute &&
		p.Time == q.Time && p.Day == q.Day && slices.Equal(p.Weekdays, q.Weekdays)
}

// normalize validates p and returns its canonical form. The error says what
// is wrong in terms a user can act on.
func (p Period) normalize() (Period, error) {
	r, err := p.parse()
	if err != nil {
		return Period{}, err
	}
	out := Period{Kind: r.kind}
	clock := time.Date(0, 1, 1, r.hour, r.minute, 0, 0, time.UTC).Format(periodTimeLayout)
	switch r.kind {
	case PeriodOnce:
		out.At = r.at.Format(periodAtLayout)
	case PeriodHourly:
		out.Every, out.Minute = r.every, r.minute
	case PeriodDaily:
		out.Time = clock
	case PeriodWeekly:
		for d, on := range r.weekdays {
			if on {
				out.Weekdays = append(out.Weekdays, d)
			}
		}
		out.Time = clock
		if len(out.Weekdays) == 7 {
			out = Period{Kind: PeriodDaily, Time: clock}
		}
	case PeriodMonthly:
		out.Day, out.Time = r.day, clock
	}
	return out, nil
}

func (p Period) parse() (rule, error) {
	r := rule{kind: p.Kind}
	var allowed []string
	var err error
	switch p.Kind {
	case "":
		return rule{}, errors.New("period: kind is required (once, hourly, daily, weekly or monthly)")
	case PeriodOnce:
		allowed = []string{"at"}
		if r.at, err = time.Parse(periodAtLayout, p.At); err != nil {
			return rule{}, fmt.Errorf("period: at %q is not a date and time written YYYY-MM-DDTHH:MM", p.At)
		}
	case PeriodHourly:
		allowed = []string{"every", "minute"}
		r.every = p.Every
		if r.every == 0 {
			r.every = 1
		}
		if !slices.Contains(hourlyIntervals, r.every) {
			return rule{}, fmt.Errorf("period: every %d hours is not offered: it must divide a day, one of 1, 2, 3, 4, 6, 8 or 12", p.Every)
		}
		if p.Minute < 0 || p.Minute > 59 {
			return rule{}, fmt.Errorf("period: minute %d is out of range 0-59", p.Minute)
		}
		r.minute = p.Minute
	case PeriodDaily, PeriodWeekly, PeriodMonthly:
		allowed = []string{"time"}
		if r.hour, r.minute, err = parseClock(p.Time); err != nil {
			return rule{}, err
		}
		switch p.Kind {
		case PeriodWeekly:
			allowed = append(allowed, "weekdays")
			if len(p.Weekdays) == 0 {
				return rule{}, errors.New("period: weekdays is required: a weekly period needs at least one day")
			}
			for _, d := range p.Weekdays {
				if d < 0 || d > 6 {
					return rule{}, fmt.Errorf("period: weekday %d is out of range 0-6 (0 is Sunday)", d)
				}
				r.weekdays[d] = true
			}
		case PeriodMonthly:
			allowed = append(allowed, "day")
			if p.Day < 1 || p.Day > 31 {
				return rule{}, fmt.Errorf("period: day %d is out of range 1-31", p.Day)
			}
			r.day = p.Day
		}
	default:
		return rule{}, fmt.Errorf("period: unknown kind %q (expected once, hourly, daily, weekly or monthly)", p.Kind)
	}

	for _, f := range p.setFields() {
		if !slices.Contains(allowed, f) {
			return rule{}, fmt.Errorf("period: %s does not apply to %s periods", f, p.Kind)
		}
	}
	return r, nil
}

func (p Period) setFields() []string {
	var set []string
	if p.At != "" {
		set = append(set, "at")
	}
	if p.Every != 0 {
		set = append(set, "every")
	}
	if p.Minute != 0 {
		set = append(set, "minute")
	}
	if p.Time != "" {
		set = append(set, "time")
	}
	if p.Weekdays != nil {
		set = append(set, "weekdays")
	}
	if p.Day != 0 {
		set = append(set, "day")
	}
	return set
}

func parseClock(s string) (hour, minute int, err error) {
	t, err := time.Parse(periodTimeLayout, s)
	if err != nil {
		if s == "" {
			return 0, 0, errors.New("period: time is required (HH:MM)")
		}
		return 0, 0, fmt.Errorf("period: time %q is not a time of day written HH:MM, 00:00 to 23:59", s)
	}
	return t.Hour(), t.Minute(), nil
}

// Next returns the first instant strictly after `after` at which the period
// fires, in after's location, or the zero time if it never fires again (a
// once period whose time has gone, or an invalid one). Callers pass a time in
// the zone the schedule is meant to keep (Schedule.TimeZone).
//
// The period is matched against the wall clock, and a daylight-saving jump is
// resolved like this:
//
//   - A wall time the clock skips (02:30 on a spring-forward night) fires at
//     the moment of the jump, so a daily run is not lost for that day. Several
//     such times collapse into that one firing.
//   - A wall time the clock shows twice (01:30 on a fall-back night) is
//     found at its first occurrence, and the next firing after that is
//     searched from the following minute, so a schedule that fires there does
//     not fire again in the repeated hour — an hourly period skips the
//     hour's second pass. Asked from inside the repeated hour (a run by hand,
//     an edit, a start then), the second occurrence is still ahead and fires.
func (p Period) Next(after time.Time) time.Time {
	r, err := p.parse()
	if err != nil {
		return time.Time{}
	}
	loc := after.Location()
	// Wall-clock times are searched as UTC times, where every one of them exists
	// exactly once, and only the matches are mapped back into loc.
	wall := time.Date(after.Year(), after.Month(), after.Day(), after.Hour(), after.Minute(), 0, 0, time.UTC)
	// A match is passed over only when none of its instants is after `after`:
	// one inside a clock jump that has already fired, at most one per minute of
	// the jump. The longest jump on record is a whole day (Samoa, 2011).
	for range 2 * 24 * 60 {
		if wall = r.nextWall(wall.Add(time.Minute)); wall.IsZero() {
			break
		}
		for _, t := range wallInstants(wall, loc) {
			if t.After(after) {
				return t
			}
		}
	}
	return time.Time{}
}

// nextWall returns the first wall-clock time at or after w that the rule
// fires at, or the zero time if there is none. w and the result are UTC.
func (r rule) nextWall(w time.Time) time.Time {
	y, m, d := w.Date()
	at := func(day, hour int) time.Time { return time.Date(y, m, day, hour, r.minute, 0, 0, time.UTC) }
	switch r.kind {
	case PeriodOnce:
		if r.at.Before(w) {
			return time.Time{}
		}
		return r.at
	case PeriodHourly:
		c := at(d, w.Hour())
		if c.Before(w) {
			c = c.Add(time.Hour)
		}
		for c.Hour()%r.every != 0 {
			c = c.Add(time.Hour)
		}
		return c
	case PeriodDaily:
		if c := at(d, r.hour); !c.Before(w) {
			return c
		}
		return at(d+1, r.hour)
	case PeriodWeekly:
		for i := 0; i <= 7; i++ {
			if c := at(d+i, r.hour); !c.Before(w) && r.weekdays[c.Weekday()] {
				return c
			}
		}
	case PeriodMonthly:
		for i := 0; i <= 1; i++ {
			first := time.Date(y, m+time.Month(i), 1, 0, 0, 0, 0, time.UTC)
			last := first.AddDate(0, 1, -1).Day()
			c := time.Date(first.Year(), first.Month(), min(r.day, last), r.hour, r.minute, 0, 0, time.UTC)
			if !c.Before(w) {
				return c
			}
		}
	}
	return time.Time{}
}

// wallInstants returns the instants, earliest first, at which the clock in loc
// reads wall (a UTC time standing for a wall-clock reading). That is one
// instant normally, two when the clock is turned back over it, and — when the
// clock jumps over it — the one instant of the jump.
func wallInstants(wall time.Time, loc *time.Location) []time.Time {
	// The offsets that can be in effect around wall: the guessed instant's zone
	// and the zones on either side of it.
	guess := time.Date(wall.Year(), wall.Month(), wall.Day(), wall.Hour(), wall.Minute(), 0, 0, loc)
	// A zero bound means the zone has no transition on that side.
	start, end := guess.ZoneBounds()
	neighbours := []time.Time{guess}
	if !start.IsZero() {
		neighbours = append(neighbours, start.Add(-time.Second))
	}
	if !end.IsZero() {
		neighbours = append(neighbours, end)
	}
	var candidates []time.Time
	for _, t := range neighbours {
		_, offset := t.Zone()
		candidates = append(candidates, wall.Add(-time.Duration(offset)*time.Second).In(loc))
	}

	var instants []time.Time
	for _, t := range candidates {
		if wallOf(t).Equal(wall) && !containsInstant(instants, t) {
			instants = append(instants, t)
		}
	}
	if len(instants) > 0 {
		sort.Slice(instants, func(i, j int) bool { return instants[i].Before(instants[j]) })
		return instants
	}

	// Skipped: fire at the jump, the first instant whose wall clock reads later
	// than wall while the one before it read earlier.
	for _, t := range candidates {
		jump, _ := t.ZoneBounds()
		if !jump.IsZero() && wallOf(jump).After(wall) && wallOf(jump.Add(-time.Second)).Before(wall) {
			return []time.Time{jump}
		}
	}
	return nil
}

func wallOf(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), time.UTC)
}

func containsInstant(ts []time.Time, t time.Time) bool {
	for _, x := range ts {
		if x.Equal(t) {
			return true
		}
	}
	return false
}
