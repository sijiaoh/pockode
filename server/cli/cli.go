// Package cli implements command-line interface for pockode.
package cli

import (
	"flag"
	"fmt"
	"os"
	"strings"
)

// RunResult represents the result of running a CLI command.
type RunResult struct {
	// Handled indicates whether a command was found and executed.
	Handled bool

	// Mode is the server mode to run after command execution.
	// Empty string means no server should be started (e.g., help command).
	Mode Mode

	// ManagerConfig is set when Mode is ModeManager.
	ManagerConfig *ManagerConfig
}

// Command represents a CLI subcommand.
type Command struct {
	Name        string
	Description string
	Run         func(args []string) (*RunResult, error)
}

// CLI manages subcommands.
type CLI struct {
	commands map[string]*Command
}

func New() *CLI {
	return &CLI{
		commands: make(map[string]*Command),
	}
}

func (c *CLI) Register(cmd *Command) {
	c.commands[cmd.Name] = cmd
}

// Run parses args and executes the appropriate command.
// Returns a RunResult indicating what action should be taken.
func (c *CLI) Run(args []string) (*RunResult, error) {
	if len(args) < 2 {
		return &RunResult{Handled: false}, nil
	}

	if strings.HasPrefix(args[1], "-") {
		return &RunResult{Handled: false}, nil
	}

	cmdName := args[1]
	cmd, ok := c.commands[cmdName]
	if !ok {
		return &RunResult{Handled: false}, nil
	}

	return cmd.Run(args[2:])
}

// RunAndGetResult runs CLI and returns the result.
// On error, prints to stderr and exits.
func (c *CLI) RunAndGetResult(args []string) *RunResult {
	result, err := c.Run(args)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	return result
}

func FlagSet(name string) *flag.FlagSet {
	return flag.NewFlagSet(name, flag.ExitOnError)
}
