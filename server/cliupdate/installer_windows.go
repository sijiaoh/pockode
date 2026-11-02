//go:build windows

package cliupdate

func (i Installer) script() Script { return i.Windows }
