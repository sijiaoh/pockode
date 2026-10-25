package schedule

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestPeriod_Rejects(t *testing.T) {
	tests := []struct {
		name    string
		period  Period
		wantMsg string
	}{
		{"no kind", Period{}, "kind is required"},
		{"unknown kind", Period{Kind: "yearly"}, "unknown kind \"yearly\""},
		{"once without a time", Period{Kind: PeriodOnce}, "is not a date and time"},
		{"once with a zone offset", Period{Kind: PeriodOnce, At: "2026-01-01T09:00+09:00"}, "is not a date and time"},
		{"once on a date that does not exist", Period{Kind: PeriodOnce, At: "2026-02-30T09:00"}, "is not a date and time"},
		{"hourly every 5", Period{Kind: PeriodHourly, Every: 5}, "must divide a day"},
		{"hourly minute out of range", Period{Kind: PeriodHourly, Minute: 60}, "minute 60 is out of range 0-59"},
		{"daily without a time", Period{Kind: PeriodDaily}, "time is required"},
		{"daily at 24:00", Period{Kind: PeriodDaily, Time: "24:00"}, "not a time of day"},
		{"weekly with no day", Period{Kind: PeriodWeekly, Time: "09:00", Weekdays: []int{}}, "at least one day"},
		{"weekday 7", Period{Kind: PeriodWeekly, Time: "09:00", Weekdays: []int{7}}, "weekday 7 is out of range 0-6"},
		{"monthly day 0", Period{Kind: PeriodMonthly, Time: "09:00"}, "day 0 is out of range 1-31"},
		{"monthly day 32", Period{Kind: PeriodMonthly, Time: "09:00", Day: 32}, "day 32 is out of range 1-31"},
		{"a field of another kind", Period{Kind: PeriodDaily, Time: "09:00", Weekdays: []int{1}}, "weekdays does not apply to daily periods"},
		{"a time on an hourly period", Period{Kind: PeriodHourly, Time: "09:00"}, "time does not apply to hourly periods"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := tt.period.normalize()
			if err == nil {
				t.Fatalf("normalize(%+v) succeeded, want error", tt.period)
			}
			if !strings.Contains(err.Error(), tt.wantMsg) {
				t.Errorf("error = %q, want it to contain %q", err, tt.wantMsg)
			}
		})
	}
}

func TestPeriod_Normalize(t *testing.T) {
	tests := []struct {
		name string
		in   Period
		want Period
	}{
		{"hourly every defaults to 1", Period{Kind: PeriodHourly, Minute: 15}, Period{Kind: PeriodHourly, Every: 1, Minute: 15}},
		{"times get two digits", Period{Kind: PeriodDaily, Time: "9:05"}, Period{Kind: PeriodDaily, Time: "09:05"}},
		{"weekdays ascend without repeats", Period{Kind: PeriodWeekly, Time: "09:00", Weekdays: []int{5, 1, 3, 1}}, Period{Kind: PeriodWeekly, Time: "09:00", Weekdays: []int{1, 3, 5}}},
		{"every day of the week is daily", Period{Kind: PeriodWeekly, Time: "09:00", Weekdays: []int{0, 1, 2, 3, 4, 5, 6}}, Period{Kind: PeriodDaily, Time: "09:00"}},
		{"once", Period{Kind: PeriodOnce, At: "2026-03-08T02:30"}, Period{Kind: PeriodOnce, At: "2026-03-08T02:30"}},
		{"monthly", Period{Kind: PeriodMonthly, Time: "18:00", Day: 31}, Period{Kind: PeriodMonthly, Time: "18:00", Day: 31}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := tt.in.normalize()
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("normalize = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestPeriod_Next(t *testing.T) {
	// 2026-01-01 is a Thursday.
	at := func(s string) time.Time {
		t.Helper()
		v, err := time.Parse("2006-01-02 15:04", s)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	daily := Period{Kind: PeriodDaily, Time: "09:30"}
	tests := []struct {
		name   string
		period Period
		after  string
		want   string // "" for never
	}{
		{"later today", daily, "2026-01-01 08:00", "2026-01-01 09:30"},
		{"tomorrow once today has passed", daily, "2026-01-01 09:30", "2026-01-02 09:30"},
		{"hourly is strictly after", Period{Kind: PeriodHourly, Every: 1}, "2026-01-01 10:00", "2026-01-01 11:00"},
		{"hourly at a minute", Period{Kind: PeriodHourly, Every: 1, Minute: 15}, "2026-01-01 10:20", "2026-01-01 11:15"},
		{"every 6 hours counts from midnight", Period{Kind: PeriodHourly, Every: 6, Minute: 15}, "2026-01-01 06:20", "2026-01-01 12:15"},
		{"every 8 hours crosses midnight", Period{Kind: PeriodHourly, Every: 8}, "2026-01-01 16:00", "2026-01-02 00:00"},
		{"weekdays skip the weekend", Period{Kind: PeriodWeekly, Time: "09:00", Weekdays: []int{1, 2, 3, 4, 5}}, "2026-01-02 09:00", "2026-01-05 09:00"},
		{"weekly a week on", Period{Kind: PeriodWeekly, Time: "09:00", Weekdays: []int{4}}, "2026-01-01 09:00", "2026-01-08 09:00"},
		{"weekly Sunday is 0", Period{Kind: PeriodWeekly, Time: "09:00", Weekdays: []int{0}}, "2026-01-01 00:00", "2026-01-04 09:00"},
		{"monthly later this month", Period{Kind: PeriodMonthly, Time: "09:00", Day: 15}, "2026-01-01 00:00", "2026-01-15 09:00"},
		{"monthly next month", Period{Kind: PeriodMonthly, Time: "09:00", Day: 1}, "2026-01-01 09:00", "2026-02-01 09:00"},
		{"day 31 is a short month's last day", Period{Kind: PeriodMonthly, Time: "09:00", Day: 31}, "2026-01-31 09:00", "2026-02-28 09:00"},
		{"and the long month's own", Period{Kind: PeriodMonthly, Time: "09:00", Day: 31}, "2026-02-28 09:00", "2026-03-31 09:00"},
		{"day 29 in a leap year", Period{Kind: PeriodMonthly, Time: "09:00", Day: 29}, "2028-01-31 00:00", "2028-02-29 09:00"},
		{"monthly rolls the year", Period{Kind: PeriodMonthly, Time: "09:00", Day: 5}, "2026-12-05 09:00", "2027-01-05 09:00"},
		{"once ahead", Period{Kind: PeriodOnce, At: "2027-06-01T09:00"}, "2026-01-01 00:00", "2027-06-01 09:00"},
		{"once at its own minute has gone", Period{Kind: PeriodOnce, At: "2026-01-01T09:00"}, "2026-01-01 09:00", ""},
		{"once passed", Period{Kind: PeriodOnce, At: "2025-12-31T09:00"}, "2026-01-01 00:00", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Within the minute, so the seconds of `after` are shown not to matter.
			after := at(tt.after).Add(59 * time.Second)
			got := tt.period.Next(after)
			if tt.want == "" {
				if !got.IsZero() {
					t.Errorf("Next(%s) = %s, want never", after, got)
				}
				return
			}
			if !got.Equal(at(tt.want)) {
				t.Errorf("Next(%s) = %s, want %s", after, got, tt.want)
			}
		})
	}
}

func TestPeriod_Next_KeepsTheCallersZone(t *testing.T) {
	tokyo := time.FixedZone("JST", 9*60*60)
	got := Period{Kind: PeriodDaily, Time: "09:00"}.Next(time.Date(2026, 1, 1, 8, 0, 0, 0, tokyo))
	want := time.Date(2026, 1, 1, 9, 0, 0, 0, tokyo)
	if !got.Equal(want) || got.Location() != tokyo {
		t.Errorf("Next = %s, want %s in JST", got, want)
	}
}

// New York springs forward at 2026-03-08 02:00 EST (to 03:00 EDT) and falls
// back at 2026-11-01 02:00 EDT (to 01:00 EST).
func TestPeriod_Next_DST(t *testing.T) {
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
	daily := func(clock string) Period { return Period{Kind: PeriodDaily, Time: clock} }
	hourly := Period{Kind: PeriodHourly, Every: 1, Minute: 30}

	tests := []struct {
		name   string
		period Period
		after  time.Time
		want   time.Time
	}{
		{"a skipped time fires at the jump", daily("02:30"), est(307, 12, 0), edt(308, 3, 0)},
		{"and the next day as usual", daily("02:30"), edt(308, 3, 0), edt(309, 2, 30)},
		{"a time just after the gap is untouched", daily("03:30"), est(307, 12, 0), edt(308, 3, 30)},
		{"hourly fires at the jump for the skipped hour", hourly, est(308, 1, 30), edt(308, 3, 0)},
		{"and carries on after it", hourly, edt(308, 3, 0), edt(308, 3, 30)},
		{"a once time inside the gap fires at the jump", Period{Kind: PeriodOnce, At: "2026-03-08T02:30"}, est(307, 12, 0), edt(308, 3, 0)},
		{"a repeated time fires at its first occurrence", daily("01:30"), edt(1031, 12, 0), edt(1101, 1, 30)},
		{"and only once", daily("01:30"), edt(1101, 1, 30), est(1102, 1, 30)},
		{"inside the repeated hour, the second occurrence is still ahead", daily("01:30"), est(1101, 1, 10), est(1101, 1, 30)},
		{"hourly does not repeat the hour", hourly, edt(1101, 1, 30), est(1101, 2, 30)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tt.period.Next(tt.after.In(ny))
			if !got.Equal(tt.want) {
				t.Errorf("Next(%s) = %s, want %s", tt.after.In(ny), got, tt.want.In(ny))
			}
		})
	}
}

func TestPeriod_Next_InvalidNeverFires(t *testing.T) {
	if got := (Period{}).Next(time.Now()); !got.IsZero() {
		t.Errorf("Next = %s, want zero", got)
	}
}
