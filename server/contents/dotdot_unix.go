//go:build !windows

package contents

// asFollowed is a link target as the OS walks it. Here that is the text
// itself: the kernel applies each ".." to the directory the components before
// it lead to, links followed, and the walk does the same.
func asFollowed(target string) string {
	return target
}
