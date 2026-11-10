// Package cloudcred keeps the machine credential that links this machine to a
// cloud account: cloud.json in the OS user's configuration directory.
//
// It lives there rather than in a data directory so that every Pockode process
// the OS user runs — servers in different projects, a cluster and the nodes it
// starts — reads the same file and is listed under the same machine.
package cloudcred

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/pockode/server/filestore"
	"github.com/pockode/server/internal/fsperm"
)

// Credential is a machine token together with the cloud that issued it.
type Credential struct {
	CloudURL     string `json:"cloud_url"`
	MachineToken string `json:"machine_token"`
}

type Store struct {
	path string
}

// DefaultStore is the store every Pockode process of this OS user shares.
func DefaultStore() (*Store, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return nil, err
	}
	return NewStore(configDir), nil
}

// NewStore keeps cloud.json under configDir/pockode.
func NewStore(configDir string) *Store {
	return &Store{path: filepath.Join(configDir, "pockode", "cloud.json")}
}

// Load returns nil if there is no file, or if it was damaged and had to be
// quarantined — either way the machine is not linked.
func (s *Store) Load() (*Credential, error) {
	var cred Credential
	found, err := filestore.ReadJSONOrQuarantine(s.path, "cloud credential", &cred)
	if err != nil || !found {
		return nil, err
	}
	return &cred, nil
}

// MachineToken returns the stored token if it was issued by cloudURL, and ""
// otherwise; see Credential.TokenFor.
func (s *Store) MachineToken(cloudURL string) (string, error) {
	cred, err := s.Load()
	if err != nil {
		return "", err
	}
	return cred.TokenFor(cloudURL), nil
}

// TokenFor returns the machine token if cloudURL issued it, and "" otherwise
// or for no credential. A token is never sent to any other cloud: whoever runs
// that one would receive a credential for this machine's account elsewhere.
func (c *Credential) TokenFor(cloudURL string) string {
	if c == nil || c.CloudURL != cloudURL {
		return ""
	}
	return c.MachineToken
}

// Save restricts the directory before writing, for the reason relay.Store.Save
// gives: the 0600 is inert on Windows, where only the directory's ACL protects
// the token.
func (s *Store) Save(cred *Credential) error {
	if err := fsperm.RestrictDir(filepath.Dir(s.path)); err != nil {
		return err
	}

	data, err := filestore.MarshalIndex(cred)
	if err != nil {
		return err
	}

	return filestore.WriteFileAtomic(s.path, data, 0600)
}

// SaveIfUnchanged saves cred only if the token stored for cred.CloudURL is
// still expected ("" for none). Otherwise it leaves the file alone and returns
// the token found in its place. Check and save are one step under the file's
// lock, which Save takes too, so no writer can slip in between: it is for a
// caller that decided to replace expected and must not overwrite anything
// else.
//
// A damaged file counts as no token, as it does for Load; it is replaced
// rather than quarantined, since nothing in it could be used.
func (s *Store) SaveIfUnchanged(cred *Credential, expected string) (saved bool, current string, err error) {
	if err := fsperm.RestrictDir(filepath.Dir(s.path)); err != nil {
		return false, "", err
	}
	data, err := filestore.MarshalIndex(cred)
	if err != nil {
		return false, "", err
	}

	err = filestore.UpdateFileAtomic(s.path, 0600, func(old []byte) ([]byte, error) {
		var stored *Credential
		if old != nil && json.Unmarshal(old, &stored) != nil {
			stored = nil
		}
		current = stored.TokenFor(cred.CloudURL)
		if current != expected {
			return nil, nil
		}
		saved = true
		return data, nil
	})
	if err != nil {
		return false, "", err
	}
	return saved, current, nil
}

func (s *Store) Delete() error {
	err := os.Remove(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
