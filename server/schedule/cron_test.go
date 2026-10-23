package schedule

import (
	"strings"
	"testing"
	"time"
	_ "time/tzdata" // DST cases need America/New_York on every CI runner.
)

func TestParseCron_Rejects(t *testing.T) {
	tests := []struct {
		expr    string
		wantMsg string
	}{
		{"* * * *", "must have 5 fields"},
		{"* * * * * *", "must have 5 fields"},
		{"60 * * * *", "minute field \"60\": 60 is out of range 0-59"},
		{"* 24 * * *", "hour field"},
		{"* * 0 * *", "day-of-month field"},
		{"* * * 13 *", "month field"},
		{"* * * * 8", "day-of-week field"},
		{"*/0 * * * *", "step \"0\" must be a positive whole number"},
		{"*/x * * * *", "must be a positive whole number"},
		{"10-5 * * * *", "runs backwards"},
		{"a * * * *", "\"a\" is not a number"},
		{"1- * * * *", "is not a number"},
		{"0 0 31 4 *", "never runs"},
		{"0 0 30,31 2 *", "never runs"},
	}
	for _, tt := range tests {
		t.Run(tt.expr, func(t *testing.T) {
			_, err := ParseCron(tt.expr)
			if err == nil {
				t.Fatalf("ParseCron(%q) succeeded, want error", tt.expr)
			}
			if !strings.Contains(err.Error(), tt.wantMsg) {
				t.Errorf("error = %q, want it to contain %q", err, tt.wantMsg)
			}
		})
	}
}

func TestParseCron_Accepts(t *testing.T) {
	for _, expr := range []string{
		"* * * * *",
		"  0   9 * * 1-5 ",
		"0 0 29 2 *",   // leap day: rare but real
		"0 0 31 4 mon", // day-of-week rescues an impossible day-of-month
		"*/15 0-6/2 1,15 jan-mar SUN",
		"5/20 * * * 7",
	} {
		if _, err := ParseCron(expr); err != nil {
			t.Errorf("ParseCron(%q): %v", expr, err)
		}
	}
}

func TestCron_Next(t *testing.T) {
	// 2026-01-01 is a Thursday.
	at := func(s string) time.Time {
		t.Helper()
		v, err := time.Parse("2006-01-02 15:04", s)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	tests := []struct {
		name  string
		expr  string
		after string
		want  string
	}{
		{"every minute is strictly after", "* * * * *", "2026-01-01 10:00", "2026-01-01 10:01"},
		{"later today", "30 9 * * *", "2026-01-01 08:00", "2026-01-01 09:30"},
		{"tomorrow once today has passed", "30 9 * * *", "2026-01-01 09:30", "2026-01-02 09:30"},
		{"step", "*/20 * * * *", "2026-01-01 10:41", "2026-01-01 11:00"},
		{"a/n runs to the end of the field", "50/5 * * * *", "2026-01-01 10:56", "2026-01-01 11:50"},
		{"weekdays skip the weekend", "0 9 * * 1-5", "2026-01-02 09:00", "2026-01-05 09:00"},
		{"7 is Sunday", "0 9 * * 7", "2026-01-01 00:00", "2026-01-04 09:00"},
		{"month rolls the year", "0 0 1 jan *", "2026-01-01 00:00", "2027-01-01 00:00"},
		{"day 31 skips short months", "0 0 31 * *", "2026-01-31 00:00", "2026-03-31 00:00"},
		{"leap day", "0 0 29 2 *", "2026-01-01 00:00", "2028-02-29 00:00"},
		{"restricted day fields match either", "0 0 13 * fri", "2026-01-01 00:00", "2026-01-02 00:00"},
		{"either: the day of the month", "0 0 3 * fri", "2026-01-02 00:00", "2026-01-03 00:00"},
		{"a starred day of month leaves the weekday alone", "0 0 */1 * fri", "2026-01-01 00:00", "2026-01-02 00:00"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, err := ParseCron(tt.expr)
			if err != nil {
				t.Fatal(err)
			}
			// Within the minute, so the seconds of `after` are shown not to matter.
			after := at(tt.after).Add(59 * time.Second)
			if got := c.Next(after); !got.Equal(at(tt.want)) {
				t.Errorf("Next(%s) = %s, want %s", after, got, tt.want)
			}
		})
	}
}

func TestCron_Next_KeepsTheCallersZone(t *testing.T) {
	tokyo := time.FixedZone("JST", 9*60*60)
	c, _ := ParseCron("0 9 * * *")
	got := c.Next(time.Date(2026, 1, 1, 8, 0, 0, 0, tokyo))
	want := time.Date(2026, 1, 1, 9, 0, 0, 0, tokyo)
	if !got.Equal(want) || got.Location() != tokyo {
		t.Errorf("Next = %s, want %s in JST", got, want)
	}
}

// New York springs forward at 2026-03-08 02:00 EST (to 03:00 EDT) and falls
// back at 2026-11-01 02:00 EDT (to 01:00 EST).
func TestCron_Next_DST(t *testing.T) {
	ny, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	est := func(d, h, m int) time.Time {
		return time.Date(2026, time.Month(d/100), d%100, h, m, 0, 0, time.FixedZone("EST", -5*3600))
	}
	edt := func(d, h, m int) time.Time {
		return time.Date(2026, time.Month(d/100), d%100, h, m, 0, 0, time.FixedZone("EDT", -4*3600))
	}

	tests := []struct {
		name  string
		expr  string
		after time.Time
		want  time.Time
	}{
		{"a skipped time fires at the jump", "30 2 * * *", est(307, 12, 0), edt(308, 3, 0)},
		{"and the next day as usual", "30 2 * * *", edt(308, 3, 0), edt(309, 2, 30)},
		{"times inside the gap collapse into one firing", "*/15 * * * *", est(308, 1, 45), edt(308, 3, 0)},
		{"after the collapsed firing the clock carries on", "*/15 * * * *", edt(308, 3, 0), edt(308, 3, 15)},
		{"a time just after the gap is untouched", "30 3 * * *", est(307, 12, 0), edt(308, 3, 30)},
		{"a repeated time fires at its first occurrence", "30 1 * * *", edt(1031, 12, 0), edt(1101, 1, 30)},
		{"and only once", "30 1 * * *", edt(1101, 1, 30), est(1102, 1, 30)},
		{"inside the repeated hour, the second occurrence is still ahead", "30 1 * * *", est(1101, 1, 10), est(1101, 1, 30)},
		{"a frequent schedule does not repeat the hour", "*/15 * * * *", edt(1101, 1, 45), est(1101, 2, 0)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, err := ParseCron(tt.expr)
			if err != nil {
				t.Fatal(err)
			}
			got := c.Next(tt.after.In(ny))
			if !got.Equal(tt.want) {
				t.Errorf("Next(%s) = %s, want %s", tt.after.In(ny), got, tt.want.In(ny))
			}
		})
	}
}

func TestCron_Next_ZeroValueNeverFires(t *testing.T) {
	if got := (Cron{}).Next(time.Now()); !got.IsZero() {
		t.Errorf("Next = %s, want zero", got)
	}
}
