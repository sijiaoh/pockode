package contents

// OpenNonBlock is nothing on Windows: a named pipe exists only under \\.\pipe,
// never in a work directory, so there is no fifo for an open to block on.
const OpenNonBlock = 0
