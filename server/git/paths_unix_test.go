//go:build !windows

package git

// The literal "->" is deliberate: it must not be confused with the rename arrow
// in git's line-based output ("old -> new"). Kept out of the shared list because
// ">" is an illegal filename character on Windows, so this file cannot even be
// created there — see paths_windows_test.go.
var platformNonASCIIPaths = []string{"箭头 -> 文件.txt"}
