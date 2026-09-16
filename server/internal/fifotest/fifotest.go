// Package fifotest creates the one kind of file that must be refused from a
// stat rather than discovered while reading: opening a fifo blocks until
// something writes to it, so any code that opens a user-named path first has to
// rule it out.
//
// It lives here because more than one package makes that assertion — contents
// on the read path, filetransfer on the download path — and because creating a
// fifo has no cross-platform form: Windows has no filesystem fifo at all, its
// named pipes living in \\.\pipe rather than in a directory a user can name.
package fifotest
