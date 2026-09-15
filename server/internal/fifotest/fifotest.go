// Package fifotest creates the one kind of file that must be refused from a
// stat rather than discovered while reading: opening a fifo blocks until
// something writes to it, so any code that opens a path it did not choose
// itself has to rule it out first.
//
// It lives here because more than one package makes that assertion — contents
// on the read path, filetransfer on the download path, agent/codex on the
// image an agent says it looked at — and because creating a fifo has no
// cross-platform form: Windows has no filesystem fifo at all, its named pipes
// living in \\.\pipe rather than in a directory a user can name.
package fifotest
