package session

import (
	"errors"
	"slices"
)

// ErrReviewerOfReviewer refuses a permission reviewer for a session that is
// itself a reviewer: Pockode denies a reviewer's own permission requests rather
// than reviewing them, so such a reviewer would never be asked anything.
var ErrReviewerOfReviewer = errors.New("a permission reviewer session has no permission reviewer of its own")

// PermissionReviewerTitle is the title a permission reviewer session is created
// with. A fixed name rather than one built from the main session's title: a
// copy of that title would go stale the moment the main session is renamed,
// and the main session is named by PermissionReviewerOf.
const PermissionReviewerTitle = "Permission reviewer"

// FindPermissionReviewer returns the permission reviewer of the main session,
// if it has one. For a lookup that must not create one — a client asking which
// reviewer to link to, deletion closing the reviewer's process; the review
// itself uses Store.EnsurePermissionReviewer.
func FindPermissionReviewer(r Reader, mainSessionID string) (SessionMeta, bool, error) {
	sessions, err := r.List()
	if err != nil {
		return SessionMeta{}, false, err
	}
	for _, sess := range sessions {
		if sess.PermissionReviewerOf == mainSessionID {
			return sess, true, nil
		}
	}
	return SessionMeta{}, false, nil
}

// withPermissionReviewers is what deleting sessionID removes: the session, if
// it is there, and every reviewer naming it. A reviewer whose main session is
// already gone is still found, so deleting by the main id cleans up after a
// deletion that was interrupted half way.
func withPermissionReviewers(sessions []SessionMeta, sessionID string) []string {
	doomed := []string{sessionID}
	for _, sess := range sessions {
		if sess.PermissionReviewerOf == sessionID {
			doomed = append(doomed, sess.ID)
		}
	}
	return doomed
}

func withoutSessions(sessions []SessionMeta, ids []string) []SessionMeta {
	kept := make([]SessionMeta, 0, len(sessions))
	for _, sess := range sessions {
		if !slices.Contains(ids, sess.ID) {
			kept = append(kept, sess)
		}
	}
	return kept
}
