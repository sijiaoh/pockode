package relay

import (
	"log/slog"
	"path/filepath"

	"github.com/pockode/server/cloudcred"
)

// DefaultCloudCredentials is the store Config.CloudCredentials takes outside
// tests, or nil — leaving the relay a guest — on a system with no
// configuration directory to keep it in.
func DefaultCloudCredentials(log *slog.Logger) *cloudcred.Store {
	store, err := cloudcred.DefaultStore()
	if err != nil {
		log.Warn("cannot locate the cloud credential, the relay will not attach to a cloud account", "error", err)
		return nil
	}
	return store
}

type InstanceKind string

const (
	InstanceServer  InstanceKind = "server"
	InstanceCluster InstanceKind = "cluster"
	InstanceNode    InstanceKind = "node"
)

// Instance is how this process is listed in its cloud account.
type Instance struct {
	Kind InstanceKind `json:"kind"`
	Name string       `json:"name"`
	// Path tells apart projects of the same name; the cloud shows it to the
	// account owner only.
	Path string `json:"path"`
}

// NewInstance describes the process working in dir, an absolute path.
func NewInstance(kind InstanceKind, dir string) Instance {
	return Instance{Kind: kind, Name: filepath.Base(dir), Path: dir}
}

// Attachment is what register and refresh add to attach the relay to a cloud
// account. It is embedded by pointer so that a guest, which has none, sends
// exactly the request it always did.
type Attachment struct {
	MachineToken string   `json:"machine_token"`
	Instance     Instance `json:"instance"`
}

// Account is the cloud's answer about the relay's account: at most one field is
// set, and neither for a guest.
type Account struct {
	// Email is the account the relay is now attached to.
	Email string `json:"account_email,omitempty"`
	// Error says the machine token was not accepted. The only value defined is
	// "invalid_machine_token"; whatever it is, linking the machine again is
	// the remedy, and the relay itself works as before.
	Error string `json:"account_error,omitempty"`
}
