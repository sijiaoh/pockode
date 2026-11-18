//go:build !windows

package contents

import "syscall"

// OpenNonBlock makes an open of a fifo return at once instead of waiting for
// the other end — failing for a writer, succeeding for a reader, who then sees
// it is no regular file; on a regular file it changes nothing. For an open
// whose target was checked to be a regular file but may have been swapped
// since.
const OpenNonBlock = syscall.O_NONBLOCK
