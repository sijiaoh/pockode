package cli

import (
	"fmt"
	"testing"
)

func TestCLI_Run_NoArgs(t *testing.T) {
	c := New()
	c.Register(&Command{
		Name:        "cmd",
		Description: "test command",
		Run:         func(args []string) (*RunResult, error) { return &RunResult{Handled: true}, nil },
	})

	result, err := c.Run([]string{"test"})
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if result.Handled {
		t.Error("expected handled to be false with no args")
	}
}

func TestCLI_Run_FlagArg(t *testing.T) {
	c := New()
	c.Register(&Command{
		Name:        "cmd",
		Description: "test command",
		Run:         func(args []string) (*RunResult, error) { return &RunResult{Handled: true}, nil },
	})

	result, err := c.Run([]string{"test", "--version"})
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if result.Handled {
		t.Error("expected handled to be false with flag arg")
	}
}

func TestCLI_Run_UnknownCommand(t *testing.T) {
	c := New()
	c.Register(&Command{
		Name:        "cmd",
		Description: "test command",
		Run:         func(args []string) (*RunResult, error) { return &RunResult{Handled: true}, nil },
	})

	result, err := c.Run([]string{"test", "unknown"})
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if result.Handled {
		t.Error("expected handled to be false with unknown command")
	}
}

func TestCLI_Run_KnownCommand(t *testing.T) {
	called := false
	c := New()
	c.Register(&Command{
		Name:        "cmd",
		Description: "test command",
		Run: func(args []string) (*RunResult, error) {
			called = true
			return &RunResult{Handled: true}, nil
		},
	})

	result, err := c.Run([]string{"test", "cmd"})
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if !result.Handled {
		t.Error("expected handled to be true")
	}
	if !called {
		t.Error("expected command to be called")
	}
}

func TestCLI_Run_PassesArgs(t *testing.T) {
	var receivedArgs []string
	c := New()
	c.Register(&Command{
		Name:        "cmd",
		Description: "test command",
		Run: func(args []string) (*RunResult, error) {
			receivedArgs = args
			return &RunResult{Handled: true}, nil
		},
	})

	result, err := c.Run([]string{"test", "cmd", "arg1", "arg2"})
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if !result.Handled {
		t.Error("expected handled to be true")
	}
	if len(receivedArgs) != 2 || receivedArgs[0] != "arg1" || receivedArgs[1] != "arg2" {
		t.Errorf("expected args [arg1 arg2], got %v", receivedArgs)
	}
}

func TestCLI_Run_CommandReturnsError(t *testing.T) {
	c := New()
	c.Register(&Command{
		Name:        "cmd",
		Description: "test command",
		Run: func(args []string) (*RunResult, error) {
			return nil, fmt.Errorf("command failed")
		},
	})

	result, err := c.Run([]string{"test", "cmd"})
	if result != nil && !result.Handled {
		// If result is nil, we can't check Handled
	}
	if err == nil {
		t.Error("expected error to be returned")
	}
	if err.Error() != "command failed" {
		t.Errorf("expected error 'command failed', got '%v'", err)
	}
}

func TestCLI_Run_ReturnsMode(t *testing.T) {
	c := New()
	c.Register(&Command{
		Name:        "cmd",
		Description: "test command",
		Run: func(args []string) (*RunResult, error) {
			return &RunResult{
				Handled: true,
				Mode:    ModeManager,
				ManagerConfig: &ManagerConfig{
					Port:      9999,
					AuthToken: "test-token",
				},
			}, nil
		},
	})

	result, err := c.Run([]string{"test", "cmd"})
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if result.Mode != ModeManager {
		t.Errorf("expected mode to be ModeManager, got %v", result.Mode)
	}
	if result.ManagerConfig == nil {
		t.Error("expected manager config to be set")
	}
	if result.ManagerConfig.Port != 9999 {
		t.Errorf("expected port 9999, got %d", result.ManagerConfig.Port)
	}
}
