package agentrole

import (
	"fmt"
	"strings"

	"github.com/pockode/server/work"
)

// CheckAssignment decides whether role roleID may be put on a work item of type
// t. Every transport that assigns a role asks here, so MCP and WebSocket refuse
// the same assignments with the same words.
//
// A refusal wraps work.ErrInvalidWork: it is the caller's mistake, and both
// transports already report that sentinel as one. Any other error is a store
// fault.
func CheckAssignment(roles Store, roleID string, t work.WorkType) error {
	if roleID == "" {
		return fmt.Errorf("%w: agent_role_id is required", work.ErrInvalidWork)
	}
	role, found, err := roles.Get(roleID)
	if err != nil {
		return fmt.Errorf("look up agent role %s: %w", roleID, err)
	}
	if !found {
		return fmt.Errorf("%w: agent role not found: %s", work.ErrInvalidWork, roleID)
	}
	if role.AcceptsWorkType(t) {
		return nil
	}

	// The refusal names the roles that would have been accepted, so an agent
	// can correct its call without a separate agent_role_list round trip.
	all, err := roles.List()
	if err != nil {
		return fmt.Errorf("list agent roles: %w", err)
	}
	var accepting []string
	for _, r := range all {
		if r.AcceptsWorkType(t) {
			accepting = append(accepting, fmt.Sprintf("%q (ID: %s)", r.Name, r.ID))
		}
	}
	alternatives := "none — change a role's work_type first"
	if len(accepting) > 0 {
		alternatives = strings.Join(accepting, ", ")
	}
	return fmt.Errorf("%w: agent role %q (ID: %s) only takes %s work, not %s; roles that take %s work: %s",
		work.ErrInvalidWork, role.Name, role.ID, role.WorkType, t, t, alternatives)
}

// CheckReassignment is CheckAssignment for an update of work workID that sets
// its role to *roleID. Only an actual change is judged: a role's work_type is
// checked when it is assigned, never afterwards, so an update that leaves the
// role alone — or names the role the work already has — goes through even if
// the role has since been restricted away from this work's type.
//
// An empty *roleID passes untouched; whether a work may be left without a role
// is the work store's call, not this check's.
func CheckReassignment(roles Store, works work.Store, workID string, roleID *string) error {
	if roleID == nil || *roleID == "" {
		return nil
	}
	w, found, err := works.Get(workID)
	if err != nil {
		return fmt.Errorf("look up work %s: %w", workID, err)
	}
	if !found {
		return work.ErrWorkNotFound
	}
	if w.AgentRoleID == *roleID {
		return nil
	}
	return CheckAssignment(roles, *roleID, w.Type())
}
