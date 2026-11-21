package session

import (
	"os"
	"path/filepath"
	"slices"

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
// asked for it to be gone and it is. deleted says whether there was one, so
// that a caller can tell a deletion apart from an id that named nothing here.
// The index is what vouches for the id before it becomes a path, the same rule
// every read path here follows, so an id this directory does not know never
// reaches the filesystem.
//
// The session's permission reviewer, if it has one, is removed with it.
//
// It must not be used on a directory a FileStore has open: that store holds the
// index in memory and the next write of its own would put the session back.
// worktree.Manager.DeleteSession is what picks the store whenever there is one.
func DeleteInDir(dataDir, sessionID string) (deleted bool, err error) {
	idx, err := readIndexFile(dataDir)
	if err != nil {
		return false, err
	}

	if !slices.ContainsFunc(idx.Sessions, func(sess SessionMeta) bool { return sess.ID == sessionID }) {
		return false, nil
	}

	// Its permission reviewer goes with it, as FileStore.Delete does.
	doomed := withPermissionReviewers(idx.Sessions, sessionID)
	for _, id := range doomed {
		if err := os.RemoveAll(filepath.Join(dataDir, "sessions", id)); err != nil {
			return false, err
		}
	}
	kept := withoutSessions(idx.Sessions, doomed)

	// Written with this build's version, as persistIndex does: what is left
	// behind has been through the same migrations a store would have applied.
	data, err := filestore.MarshalIndex(indexData{Version: indexVersion, Sessions: kept})
	if err != nil {
		return false, err
	}
	if err := filestore.WriteFileAtomic(indexPath(dataDir), data, 0644); err != nil {
		return false, err
	}
	return true, nil
}
