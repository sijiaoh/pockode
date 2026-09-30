package cliupdate

import (
	"net/http"
	"time"
)

// SetRegistry points the latest-release reads at baseURL, a test's server.
func (s *Service) SetRegistry(baseURL string) {
	s.registry = registryClient{baseURL: baseURL, http: http.DefaultClient}
}

// SetUpdateTimeout shortens the budget of updates started afterwards, so a
// test can watch one run out.
func (s *Service) SetUpdateTimeout(d time.Duration) { s.updateTimeout = d }

// SetLockDir moves the machine-wide update locks to dir, so that tests
// neither touch the user's nor contend with each other unless they share one.
func (s *Service) SetLockDir(dir string) { s.lockDir = dir }

// SetNotAppliedFor shortens how long an update that was not applied holds the
// release back.
func (s *Service) SetNotAppliedFor(d time.Duration) { s.notAppliedFor = d }

var (
	CompareVersions = compareVersions
	Redact          = redact
	OutputTail      = outputTail
)
