package cli

import (
	"fmt"
	"os"
	"text/tabwriter"

	"github.com/pockode/server/globalconfig"
)

// WorkspaceCommand returns the "workspace" subcommand.
func WorkspaceCommand() *Command {
	return &Command{
		Name:        "workspace",
		Description: "Manage workspaces",
		Run:         runWorkspace,
	}
}

func runWorkspace(args []string) (*RunResult, error) {
	if len(args) == 0 {
		printWorkspaceUsage()
		return &RunResult{Handled: true}, nil
	}

	var err error
	switch args[0] {
	case "add":
		err = runWorkspaceAdd(args[1:])
	case "list", "ls":
		err = runWorkspaceList(args[1:])
	case "remove", "rm":
		err = runWorkspaceRemove(args[1:])
	case "help", "-h", "--help":
		printWorkspaceUsage()
		return &RunResult{Handled: true}, nil
	default:
		return nil, fmt.Errorf("unknown workspace subcommand: %s", args[0])
	}

	if err != nil {
		return nil, err
	}
	return &RunResult{Handled: true}, nil
}

func printWorkspaceUsage() {
	fmt.Println("Usage: pockode workspace <subcommand>")
	fmt.Println()
	fmt.Println("Subcommands:")
	fmt.Println("  add [path]     Register a workspace (default: current directory)")
	fmt.Println("  list, ls       List all registered workspaces")
	fmt.Println("  remove, rm     Remove a workspace by ID or path")
	fmt.Println("  help           Show this help message")
}

func runWorkspaceAdd(args []string) error {
	fs := FlagSet("workspace add")
	nameFlag := fs.String("name", "", "display name for the workspace")
	if err := fs.Parse(args); err != nil {
		return err
	}

	path := "."
	if fs.NArg() > 0 {
		path = fs.Arg(0)
	}

	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return fmt.Errorf("path does not exist: %s", path)
	}
	if err != nil {
		return fmt.Errorf("access path: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("path is not a directory: %s", path)
	}

	store, err := globalconfig.NewWorkspaceStore()
	if err != nil {
		return fmt.Errorf("init workspace store: %w", err)
	}

	ws, err := store.Register(path, *nameFlag)
	if err != nil {
		return fmt.Errorf("register workspace: %w", err)
	}

	fmt.Printf("Workspace registered:\n")
	fmt.Printf("  ID:   %s\n", ws.ID)
	fmt.Printf("  Name: %s\n", ws.Name)
	fmt.Printf("  Path: %s\n", ws.Path)

	return nil
}

func runWorkspaceList(args []string) error {
	fs := FlagSet("workspace list")
	quietFlag := fs.Bool("q", false, "only show IDs")
	if err := fs.Parse(args); err != nil {
		return err
	}

	store, err := globalconfig.NewWorkspaceStore()
	if err != nil {
		return fmt.Errorf("init workspace store: %w", err)
	}

	workspaces, err := store.List()
	if err != nil {
		return fmt.Errorf("list workspaces: %w", err)
	}

	if len(workspaces) == 0 {
		fmt.Println("No workspaces registered.")
		fmt.Println("Use 'pockode workspace add' to register a workspace.")
		return nil
	}

	if *quietFlag {
		for _, ws := range workspaces {
			fmt.Println(ws.ID)
		}
		return nil
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tNAME\tPATH\tLAST ACCESSED")
	for _, ws := range workspaces {
		lastAccessed := "-"
		if !ws.LastAccessed.IsZero() {
			lastAccessed = ws.LastAccessed.Format("2006-01-02 15:04")
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\n",
			ws.ID,
			ws.Name,
			ws.Path,
			lastAccessed,
		)
	}
	w.Flush()

	return nil
}

func runWorkspaceRemove(args []string) error {
	fs := FlagSet("workspace remove")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if fs.NArg() == 0 {
		return fmt.Errorf("workspace ID or path required")
	}

	target := fs.Arg(0)

	store, err := globalconfig.NewWorkspaceStore()
	if err != nil {
		return fmt.Errorf("init workspace store: %w", err)
	}

	// Try to find by ID first
	ws, err := store.Get(target)
	if err != nil {
		return fmt.Errorf("lookup workspace: %w", err)
	}

	// If not found by ID, try by path
	if ws == nil {
		ws, err = store.GetByPath(target)
		if err != nil {
			return fmt.Errorf("lookup workspace by path: %w", err)
		}
	}

	if ws == nil {
		return fmt.Errorf("workspace not found: %s", target)
	}

	if err := store.Delete(ws.ID); err != nil {
		return fmt.Errorf("delete workspace: %w", err)
	}

	fmt.Printf("Workspace removed: %s (%s)\n", ws.Name, ws.Path)
	return nil
}
