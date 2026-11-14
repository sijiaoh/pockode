package cliauth

import "time"

// SetLoginTimeout shortens the deadline of sign-ins started afterwards, so a
// test can watch one expire.
func (s *Service) SetLoginTimeout(d time.Duration) { s.loginTimeout = d }

// SetReleaseTimeout shortens how long a removal waits, from when it starts
// waiting for the profile's lock, for its release to return.
func (s *Service) SetReleaseTimeout(d time.Duration) { s.releaseTimeout = d }
