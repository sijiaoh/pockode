package cli

import (
	"fmt"
	"os"

	"github.com/pockode/server/globalconfig"
)

// ManagerCommand returns the "manager" subcommand.
func ManagerCommand() *Command {
	return &Command{
		Name:        "manager",
		Description: "Manage the pockode manager process",
		Run:         runManager,
	}
}

func runManager(args []string) (*RunResult, error) {
	if len(args) == 0 {
		printManagerUsage()
		return &RunResult{Handled: true}, nil
	}

	switch args[0] {
	case "start":
		return runManagerStart(args[1:])
	case "status":
		return runManagerStatus()
	case "help", "-h", "--help":
		printManagerUsage()
		return &RunResult{Handled: true}, nil
	default:
		return nil, fmt.Errorf("unknown manager subcommand: %s", args[0])
	}
}

func printManagerUsage() {
	fmt.Println("Usage: pockode manager <subcommand>")
	fmt.Println()
	fmt.Println("Subcommands:")
	fmt.Println("  start    Start the manager process")
	fmt.Println("  status   Show manager status")
	fmt.Println("  help     Show this help message")
}

// ManagerConfig holds configuration for starting the manager.
type ManagerConfig struct {
	Port      int
	AuthToken string
	CloudURL  string
}

// ParseManagerStart parses manager start arguments and returns config.
// This allows main.go to handle the actual server startup.
func ParseManagerStart(args []string) (*ManagerConfig, error) {
	fs := FlagSet("manager start")
	portFlag := fs.Int("port", 0, "override port")
	tokenFlag := fs.String("auth-token", "", "override auth token")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}

	cfgStore, err := globalconfig.NewConfigStore()
	if err != nil {
		return nil, fmt.Errorf("load global config: %w", err)
	}
	cfg := cfgStore.Get()

	port := cfg.DefaultPort
	if *portFlag != 0 {
		port = *portFlag
	}

	authToken := cfg.AuthToken
	if *tokenFlag != "" {
		authToken = *tokenFlag
	}

	// Check environment variable as fallback
	if authToken == "" {
		authToken = os.Getenv("AUTH_TOKEN")
	}
	if authToken == "" {
		return nil, fmt.Errorf("auth token required: set via --auth-token, AUTH_TOKEN env, or global config")
	}

	return &ManagerConfig{
		Port:      port,
		AuthToken: authToken,
		CloudURL:  cfg.CloudURL,
	}, nil
}

func runManagerStart(args []string) (*RunResult, error) {
	cfg, err := ParseManagerStart(args)
	if err != nil {
		return nil, err
	}

	return &RunResult{
		Handled:       true,
		Mode:          ModeManager,
		ManagerConfig: cfg,
	}, nil
}

func runManagerStatus() (*RunResult, error) {
	fmt.Println("Manager status: not implemented yet")
	return &RunResult{Handled: true}, nil
}
