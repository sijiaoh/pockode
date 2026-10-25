package schedule

import (
	"errors"
	"fmt"
	"time"

	// A schedule names its zone, so the zone database has to be there on every
	// host: Windows has none, and neither do minimal container images.
	_ "time/tzdata"
)

// loadZone resolves a schedule's TimeZone. Only IANA names are accepted:
// time.LoadLocation also takes "" (UTC) and "Local" (whatever zone the server
// is in), and either would quietly give the schedule a zone nobody chose.
func loadZone(name string) (*time.Location, error) {
	switch name {
	case "":
		return nil, errors.New("time_zone is required (an IANA name such as \"Asia/Tokyo\")")
	case "Local":
		return nil, fmt.Errorf("time zone %q is not an IANA name such as \"Asia/Tokyo\"", name)
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		return nil, fmt.Errorf("unknown time zone %q: expected an IANA name such as \"Asia/Tokyo\"", name)
	}
	return loc, nil
}
