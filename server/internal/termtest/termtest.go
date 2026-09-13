// Package termtest reports whether a process still shares the terminal of the
// process that started it, so a test can assert that a child was detached from
// ours — or that it was not.
//
// It lives apart from the code that does the detaching because the state being
// read has no common shape — a session on unix, a console on Windows — and two
// packages need the same answer: cluster/node proves a node leaves the terminal
// its cluster was launched from, and agent proves the AI CLI it spawns does not
// land back on the server's.
//
// "Terminal" here means whatever the OS ties a process to for the purpose of
// terminal-wide events: the session on unix (what Setsid changes, and what owns
// the controlling terminal), the console on Windows (what DETACHED_PROCESS
// withholds, and what console control events travel over).
//
// Nothing here belongs in production code. Detachment is decided when a process
// is created, and no part of Pockode has a reason to ask about it afterwards.
package termtest

// Attachment is what Of reports. It is a string rather than a bool so a failing
// test says what it saw — including why the answer could not be determined.
type Attachment string

const (
	// SharesParent means terminal-wide events aimed at the parent's terminal
	// still reach this process.
	SharesParent Attachment = "shares the parent's terminal"
	// Detached means they do not.
	Detached Attachment = "detached from the parent's terminal"
)
