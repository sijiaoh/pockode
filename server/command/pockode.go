package command

import (
	"errors"
	"fmt"
	"strings"
	"unicode"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/git"
	"github.com/pockode/server/work"
)

// PockodePrefix marks a command name as Pockode's own. The whole prefix belongs
// to Pockode: a message invoking a name under it is expanded here or refused,
// never passed to the agent, so a typo cannot reach the agent as a prompt and a
// user's own command cannot quietly shadow one Pockode adds later.
//
// The web client draws its local echo by the same prefix
// (POCKODE_COMMAND_PREFIX in web/src/utils/pockodeCommand.ts); keep the two in
// sync.
const PockodePrefix = "pockode-"

// PockodeCommand is a slash command Pockode expands into a prompt before the
// agent sees it. Expansion is all it does: anything that has to happen is the
// agent's to do through MCP, which keeps a command meaning the same thing to
// every agent.
type PockodeCommand struct {
	Name        string
	Description string
	// needsGit leaves the command out of the list in a project that is not a
	// git repository, and refuses it there when typed anyway.
	needsGit bool
	expand   func(env PockodeEnv, args string) (string, error)
}

// PockodeEnv is what a command may read about where it was invoked.
type PockodeEnv struct {
	// WorkDir is the worktree the invoking session runs in.
	WorkDir string
	// IsGitRepo is whether the project is a git repository, as the worktree
	// registry last read it.
	IsGitRepo bool
}

// PockodeCommands lists every Pockode command, in the order they are offered.
var PockodeCommands = []PockodeCommand{
	{
		Name:        "pockode-lead",
		Description: "Lead the work just discussed through Pockode stories",
		needsGit:    true,
		expand:      expandLead,
	},
}

var (
	// ErrUnknownPockodeCommand is a name under PockodePrefix that is not one of
	// PockodeCommands.
	ErrUnknownPockodeCommand = errors.New("unknown Pockode command")
	// ErrNoBranch is a command that needs the worktree's branch, invoked while
	// HEAD is on none.
	ErrNoBranch = errors.New("the worktree is not on a branch")
	// ErrNotGitRepo is a command that needs git, invoked in a project that is
	// not a git repository.
	ErrNotGitRepo = errors.New("not a git repository")
)

// refusal is an ExpandPockode error that is the user's to act on. The client
// shows its text as it is, so it is worded for them rather than as an error
// chain, and it still matches its sentinel under errors.Is.
type refusal struct {
	kind error
	msg  string
}

func (r *refusal) Error() string { return r.msg }
func (r *refusal) Unwrap() error { return r.kind }

// IsRefusal reports whether an ExpandPockode error is the user's to act on, and
// so to be shown to them as it is rather than reported as a server failure.
func IsRefusal(err error) bool {
	var r *refusal
	return errors.As(err, &r)
}

// ParsePockode reports whether content invokes a Pockode command, and splits it
// into the name and what followed it. Whether the name is a known command is
// left to ExpandPockode, so that an unknown one is still recognised as Pockode's
// and refused rather than sent on.
func ParsePockode(content string) (agent.CommandInvocation, bool) {
	rest, ok := strings.CutPrefix(content, "/"+PockodePrefix)
	if !ok {
		return agent.CommandInvocation{}, false
	}
	name, args := rest, ""
	if i := strings.IndexFunc(rest, unicode.IsSpace); i >= 0 {
		name, args = rest[:i], strings.TrimSpace(rest[i:])
	}
	return agent.CommandInvocation{Name: PockodePrefix + name, Args: args}, true
}

// ExpandPockode returns the prompt a Pockode command stands for. An error for
// which IsRefusal holds is about the invocation and the user's to act on; any
// other is a failure to read what the command needs.
func ExpandPockode(inv agent.CommandInvocation, env PockodeEnv) (string, error) {
	if cmd, ok := findPockode(inv.Name); ok {
		if cmd.needsGit && !env.IsGitRepo {
			return "", &refusal{ErrNotGitRepo,
				fmt.Sprintf("/%s needs a git repository. Ask the AI to run `git init`, then send it again.", cmd.Name)}
		}
		return cmd.expand(env, inv.Args)
	}
	// Only what would be accepted here, as command.list offers.
	var names []string
	for _, cmd := range PockodeCommands {
		if cmd.needsGit && !env.IsGitRepo {
			continue
		}
		names = append(names, "/"+cmd.Name)
	}
	msg := fmt.Sprintf("Unknown Pockode command \"/%s\".", inv.Name)
	if len(names) > 0 {
		msg += " Available: " + strings.Join(names, ", ")
	}
	return "", &refusal{ErrUnknownPockodeCommand, msg}
}

func findPockode(name string) (PockodeCommand, bool) {
	for _, cmd := range PockodeCommands {
		if cmd.Name == name {
			return cmd, true
		}
	}
	return PockodeCommand{}, false
}

func expandLead(env PockodeEnv, args string) (string, error) {
	// The branch is what finished stories get merged into, so there is no
	// prompt worth sending without one.
	branch, err := git.CurrentBranch(env.WorkDir)
	if errors.Is(err, git.ErrDetachedHead) {
		return "", &refusal{ErrNoBranch,
			"/pockode-lead needs the current branch, but HEAD is detached. Check out a branch and send it again."}
	}
	if err != nil {
		return "", fmt.Errorf("read the current branch: %w", err)
	}
	return work.BuildPockodeLeadPrompt(branch, args), nil
}
