package process

import "github.com/pockode/server/agent"

// stampProfile writes the account this process's CLI runs as onto the records
// that say something happened to that account — a credentials refusal, a usage
// limit hit — so a record keeps which account it was after the current one has
// changed (agent.UsageLimit.ProfileID). The adapter cannot be trusted with it:
// the account is chosen here, before the CLI starts, and this is the one place
// every event of the session passes through on its way to the transcript.
//
// The markers are copied rather than written through: the adapter's pointer is
// not this function's to change.
func stampProfile(event agent.AgentEvent, profileID string) agent.AgentEvent {
	switch e := event.(type) {
	case agent.WarningEvent:
		e.AuthFailure = withAuthProfile(e.AuthFailure, profileID)
		e.UsageLimit = withLimitProfile(e.UsageLimit, profileID)
		return e
	case agent.ErrorEvent:
		e.AuthFailure = withAuthProfile(e.AuthFailure, profileID)
		e.UsageLimit = withLimitProfile(e.UsageLimit, profileID)
		return e
	}
	return event
}

func withAuthProfile(f *agent.AuthFailure, profileID string) *agent.AuthFailure {
	if f == nil {
		return nil
	}
	stamped := *f
	stamped.ProfileID = profileID
	return &stamped
}

func withLimitProfile(l *agent.UsageLimit, profileID string) *agent.UsageLimit {
	if l == nil {
		return nil
	}
	stamped := *l
	stamped.ProfileID = profileID
	return &stamped
}
