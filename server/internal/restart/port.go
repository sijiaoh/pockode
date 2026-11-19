package restart

import (
	"os"
	"strconv"
	"strings"
)

// PortEnvVar carries the port a process was listening on over to the run a
// restart replaces it with, which starts its search for a free port there
// rather than at -port.
//
// Without it every restart searches from -port again — for a node, which is
// started with no arguments, from the default — and a node restarted while
// another holds that port comes back on a different one, so whatever was
// pointed at the old address loses it.
//
// The environment rather than a replayed -port, because the arguments are the
// user's: a flag rewritten in argv would have to be found among positional
// arguments and the cluster subcommand, and would show the port as one the
// user chose. The value is taken out of the environment at startup
// (TakePort), so it reaches only the replacing run: not the AI CLIs, not a
// cluster's nodes, which inherit the cluster's environment and have ports of
// their own.
const PortEnvVar = "POCKODE_RESTART_PORT"

// TakePort returns the port to start looking for a free one at: the port the
// process this one replaces was listening on, if it is a restart, and
// configured otherwise. It unsets PortEnvVar, so call it at startup before
// anything is spawned.
//
// The kept port wins over configured even when -port was given explicitly:
// the old process started its search from that same -port, so the kept port
// is what the user's port resolved to — the one their clients are using. It is
// still a starting point, not a demand: taken meanwhile, the search falls
// forward from it.
//
// A value that is not a port is ignored. Only a restart writes it, so one that
// does not parse was not put there by pockode, and the configured port is the
// right answer to it.
func TakePort(configured int) int {
	value, ok := os.LookupEnv(PortEnvVar)
	os.Unsetenv(PortEnvVar)
	if !ok {
		return configured
	}
	port, err := strconv.Atoi(value)
	if err != nil || port < 1 || port > 65535 {
		return configured
	}
	return port
}

// KeepPort records the port this process is listening on, for the run a
// restart starts to prefer (PortEnvVar). Call it once the listener is bound;
// a process that restarts without having called it leaves the new run to
// its -port.
func (r *Restarter) KeepPort(port int) {
	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	r.port = port
}

// withPort returns env with PortEnvVar set to port, or removed if port is 0,
// any inherited value dropped so the new run sees exactly one.
func withPort(env []string, port int) []string {
	prefix := PortEnvVar + "="
	out := make([]string, 0, len(env)+1)
	for _, kv := range env {
		if !strings.HasPrefix(kv, prefix) {
			out = append(out, kv)
		}
	}
	if port == 0 {
		return out
	}
	return append(out, prefix+strconv.Itoa(port))
}
