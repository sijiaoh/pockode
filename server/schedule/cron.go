package schedule

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Cron is a parsed standard 5-field cron expression:
//
//	minute hour day-of-month month day-of-week
//
// Each field takes `*`, a value, a range `a-b`, a step `*/n`, `a-b/n` or `a/n`
// (from a to the field's maximum), or a comma-separated list of those. Months
// and weekdays also take their English three-letter names; day-of-week 7 is
// Sunday, as is 0.
//
// As in Vixie cron, when both day-of-month and day-of-week are restricted
// (neither starts with `*`) a day matches if either one does; otherwise both
// must.
type Cron struct {
	minute, hour, dom, month, dow bitset
	domStar, dowStar              bool
}

// bitset holds the allowed values of one field; bit i is value i.
type bitset uint64

func (b bitset) has(v int) bool { return b&(1<<uint(v)) != 0 }

type cronField struct {
	name     string
	min, max int
	names    map[string]int
}

var (
	minuteField = cronField{name: "minute", min: 0, max: 59}
	hourField   = cronField{name: "hour", min: 0, max: 23}
	domField    = cronField{name: "day-of-month", min: 1, max: 31}
	monthField  = cronField{name: "month", min: 1, max: 12, names: map[string]int{
		"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
		"jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
	}}
	// 7 is accepted as a second spelling of Sunday and folded onto 0 after parsing.
	dowField = cronField{name: "day-of-week", min: 0, max: 7, names: map[string]int{
		"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6,
	}}
)

// ParseCron parses a standard 5-field cron expression. The error says what is
// wrong in terms a user can act on, including an expression whose dates can
// never occur (such as `0 0 31 4 *`): it would be accepted and then never run.
func ParseCron(expr string) (Cron, error) {
	fields := strings.Fields(expr)
	if len(fields) != 5 {
		return Cron{}, fmt.Errorf("cron expression %q must have 5 fields (minute hour day-of-month month day-of-week), got %d", expr, len(fields))
	}

	var c Cron
	var err error
	specs := []struct {
		field cronField
		dst   *bitset
	}{
		{minuteField, &c.minute},
		{hourField, &c.hour},
		{domField, &c.dom},
		{monthField, &c.month},
		{dowField, &c.dow},
	}
	for i, spec := range specs {
		if *spec.dst, err = spec.field.parse(fields[i]); err != nil {
			return Cron{}, fmt.Errorf("cron expression %q: %w", expr, err)
		}
	}
	if c.dow.has(7) {
		c.dow = c.dow&^(1<<7) | 1
	}
	c.domStar = strings.HasPrefix(fields[2], "*")
	c.dowStar = strings.HasPrefix(fields[4], "*")

	if !c.canOccur() {
		return Cron{}, fmt.Errorf("cron expression %q never runs: no month it names has the day of the month it names", expr)
	}
	return c, nil
}

func (f cronField) parse(s string) (bitset, error) {
	var set bitset
	for _, part := range strings.Split(s, ",") {
		bits, err := f.parsePart(part)
		if err != nil {
			return 0, fmt.Errorf("%s field %q: %w", f.name, s, err)
		}
		set |= bits
	}
	return set, nil
}

func (f cronField) parsePart(part string) (bitset, error) {
	rangePart, stepPart, hasStep := strings.Cut(part, "/")

	lo, hi := f.min, f.max
	switch {
	case rangePart == "*":
	case strings.Contains(rangePart, "-"):
		a, b, _ := strings.Cut(rangePart, "-")
		var err error
		if lo, err = f.value(a); err != nil {
			return 0, err
		}
		if hi, err = f.value(b); err != nil {
			return 0, err
		}
		if lo > hi {
			return 0, fmt.Errorf("range %s-%s runs backwards", a, b)
		}
	default:
		v, err := f.value(rangePart)
		if err != nil {
			return 0, err
		}
		lo = v
		// A bare value is just itself; with a step it starts a run to the end
		// of the field, as `a/n` does in Vixie cron.
		if !hasStep {
			hi = v
		}
	}

	step := 1
	if hasStep {
		n, err := strconv.Atoi(stepPart)
		if err != nil || n <= 0 {
			return 0, fmt.Errorf("step %q must be a positive whole number", stepPart)
		}
		step = n
	}

	var bits bitset
	for v := lo; v <= hi; v += step {
		bits |= 1 << uint(v)
	}
	return bits, nil
}

func (f cronField) value(s string) (int, error) {
	if v, ok := f.names[strings.ToLower(s)]; ok {
		return v, nil
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return 0, fmt.Errorf("%q is not a number", s)
	}
	if v < f.min || v > f.max {
		return 0, fmt.Errorf("%d is out of range %d-%d", v, f.min, f.max)
	}
	return v, nil
}

// daysInMonth is the most days each month can have; February counts its leap day.
var daysInMonth = [13]int{0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}

// canOccur reports whether some date satisfies the day and month fields. Only
// the two can contradict each other — every hour and minute exists on every
// day — and only when the day of the week cannot rescue the day of the month:
// when it is restricted too, either matching is enough.
func (c Cron) canOccur() bool {
	if !c.domStar && !c.dowStar {
		return true
	}
	for m := 1; m <= 12; m++ {
		if !c.month.has(m) {
			continue
		}
		for d := 1; d <= daysInMonth[m]; d++ {
			if c.dom.has(d) {
				return true
			}
		}
	}
	return false
}

func (c Cron) dayMatches(t time.Time) bool {
	dom := c.dom.has(t.Day())
	dow := c.dow.has(int(t.Weekday()))
	if c.domStar || c.dowStar {
		return dom && dow
	}
	return dom || dow
}

// Next returns the first instant strictly after `after` at which the schedule
// fires, in after's location; callers pass a time in the zone the schedule is
// meant to keep (the server's local zone).
//
// The fields are matched against the wall clock, and a daylight-saving jump is
// resolved like this:
//
//   - A wall time the clock skips (02:30 on a spring-forward night) fires at
//     the moment of the jump, so a daily run is not lost for that day. Several
//     such times collapse into that one firing.
//   - A wall time the clock shows twice (01:30 on a fall-back night) fires
//     once, at its first occurrence. The consequence for a frequent schedule
//     is that it does not fire again during the repeated hour.
func (c Cron) Next(after time.Time) time.Time {
	loc := after.Location()
	// Wall-clock times are searched as UTC times, where every one of them exists
	// exactly once, and only the matches are mapped back into loc.
	wall := time.Date(after.Year(), after.Month(), after.Day(), after.Hour(), after.Minute(), 0, 0, time.UTC)
	// Every expression ParseCron accepts recurs within 8 years (29 February in
	// a century that skips its leap year); the bound only keeps a hand-built
	// Cron from searching forever.
	limit := wall.AddDate(9, 0, 0)
	for wall = wall.Add(time.Minute); wall.Before(limit); wall = wall.Add(time.Minute) {
		if wall = c.nextWall(wall, limit); wall.IsZero() {
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

// nextWall returns the first wall-clock time at or after w that matches, or
// the zero time if there is none before limit. w and the result are UTC.
func (c Cron) nextWall(w, limit time.Time) time.Time {
	for w.Before(limit) {
		switch {
		case !c.month.has(int(w.Month())):
			w = time.Date(w.Year(), w.Month()+1, 1, 0, 0, 0, 0, time.UTC)
		case !c.dayMatches(w):
			w = time.Date(w.Year(), w.Month(), w.Day()+1, 0, 0, 0, 0, time.UTC)
		case !c.hour.has(w.Hour()):
			w = w.Truncate(time.Hour).Add(time.Hour)
		case !c.minute.has(w.Minute()):
			w = w.Add(time.Minute)
		default:
			return w
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
