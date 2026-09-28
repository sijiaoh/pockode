package cliauth

import "time"

// SetLoginTimeout shortens the deadline of sign-ins started afterwards, so a
// test can watch one expire.
func (s *Service) SetLoginTimeout(d time.Duration) { s.loginTimeout = d }
