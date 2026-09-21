package session

import (
	"os"
	"path/filepath"

	"github.com/pockode/server/filestore"
)

// DeleteInDir removes one session from a data directory no store is open on.
//
// It is the discarding half of what DirReader reads. A worktree's sessions
// outlive the worktree, so the ways they are thrown away have to outlive it
// too: without this, data kept past a deletion could only ever grow. Read-only
// is about the conversation — there is no process to talk to and nothing to
// continue — and says nothing about whether the record may be dropped.
//
// A missing session is not an error, as FileStore.Delete treats it: the caller
// asked for it to be gone and it is. The index is what vouches for the id
// before it becomes a path, the same rule every read path here follows, so an
// id this directory does not know never reaches the filesystem.
//
// It must not be used on a directory a FileStore has open: that store holds the
// index in memory and the next write of its own would put the session back.
// worktree.Manager.DeleteSession is what picks the store whenever there is one.
func DeleteInDir(dataDir, sessionID string) error {
	idx, err := readIndexFile(dataDir)
	if err != nil {
		return err
	}

	kept := make([]SessionMeta, 0, len(idx.Sessions))
	found := false
	for _, sess := range idx.Sessions {
		if sess.ID == sessionID {
			found = true
			continue
		}
		kept = append(kept, sess)
	}
	if !found {
		return nil
	}

	if err := os.RemoveAll(filepath.Join(dataDir, "sessions", sessionID)); err != nil {
		return err
	}

	// Written with this build's version, as persistIndex does: what is left
	// behind has been through the same migrations a store would have applied.
	data, err := filestore.MarshalIndex(indexData{Version: indexVersion, Sessions: kept})
	if err != nil {
		return err
	}
	return filestore.WriteFileAtomic(indexPath(dataDir), data, 0644)
}
