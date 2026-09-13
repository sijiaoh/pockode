// Package unwritabletest makes a directory refuse new entries, so a test can
// stand in for the I/O failures that are otherwise unreachable — a full disk, a
// data directory the user cannot write to.
//
// It is a package rather than a helper in each test because the two platforms
// disagree about whether the state can be arranged at all, and that reasoning
// should be written down once. See the per-platform files.
package unwritabletest
