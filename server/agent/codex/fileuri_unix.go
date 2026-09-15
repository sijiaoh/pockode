//go:build !windows

package codex

// uriPathToNative converts the path component of a file URI to a native path.
// Here they are already the same thing.
func uriPathToNative(path string) string {
	return path
}
