package cloudlogin

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pockode/server/cloudcred"
	"github.com/pockode/server/relay"
)

// CredentialState is what cloud.json says, as seen by this process's cloud.
type CredentialState string

const (
	CredentialNone CredentialState = "none"
	// CredentialLinked is a token issued by this process's cloud. Whether the
	// cloud still accepts it is RelayState's to say.
	CredentialLinked CredentialState = "linked"
	// CredentialOtherCloud is a token issued by another cloud, which this
	// process never uses. Linking replaces it; unlinking revokes it there.
	CredentialOtherCloud CredentialState = "other_cloud"
)

// RelayState is the relay's last account result.
type RelayState string

const (
	// RelayDisabled is a process running without the relay: nothing is
	// attached, and only the credential says anything.
	RelayDisabled RelayState = "disabled"
	// RelayPending is a relay that has yet to present cloud.json as it is now:
	// the file changed since its last register or refresh.
	RelayPending  RelayState = "pending"
	RelayGuest    RelayState = "guest"
	RelayAttached RelayState = "attached"
	// RelayLinkInvalid is the cloud refusing the machine token; linking again
	// fixes it.
	RelayLinkInvalid RelayState = "link_invalid"
	// RelayNotAttached is the cloud not attaching for a reason linking again
	// cannot fix (relay.Account.NotAttached).
	RelayNotAttached RelayState = "not_attached"
)

// Status is this process's link to its cloud account as a client shows it.
// Reading it asks the cloud nothing.
type Status struct {
	// CloudURL is this process's -cloud-url, the cloud a flow links to.
	CloudURL   string          `json:"cloud_url"`
	Credential CredentialState `json:"credential"`
	// OtherCloudURL is the cloud that issued the stored token, with
	// CredentialOtherCloud: the one an unlink would revoke at.
	OtherCloudURL string     `json:"other_cloud_url,omitempty"`
	Relay         RelayState `json:"relay"`
	// MachineName is this machine as a flow would identify it to the cloud
	// now (os_user@hostname), read locally; empty when it cannot be worked
	// out. The name the cloud lists is the one it was given at linking, so
	// after a hostname change the two can differ: this one is the machine a
	// link or an unlink acts on.
	MachineName string `json:"machine_name,omitempty"`
	// Email is the account the relay is attached to, with RelayAttached.
	Email string `json:"email,omitempty"`
	// Flow is the latest flow — the running one, or the last to end — or nil
	// when there has been none since the process started. The last one is
	// kept so that a client that was away when it ended still learns how.
	Flow *Flow `json:"flow,omitempty"`
}

// FlowPhase is where a link flow stands.
type FlowPhase string

const (
	// FlowStarting is the existing link being checked and a code requested;
	// there is nothing to show yet.
	FlowStarting FlowPhase = "starting"
	// FlowWaiting is waiting for the user to approve: the code and the link
	// are set.
	FlowWaiting FlowPhase = "waiting"
	// FlowFinishing is a flow the user approved: it holds the machine token
	// and is saving it, or revoking it if a valid link was written meanwhile.
	// It can no longer be cancelled.
	FlowFinishing FlowPhase = "finishing"
	FlowLinked    FlowPhase = "linked"
	// FlowAlreadyLinked is a flow that found the machine linked by a valid
	// token for this cloud — at the start, or written meanwhile by another
	// process — and left that link alone.
	FlowAlreadyLinked FlowPhase = "already_linked"
	FlowFailed        FlowPhase = "failed"
	FlowCanceled      FlowPhase = "canceled"
)

// Ended reports whether nothing more will happen to a flow in this phase.
func (p FlowPhase) Ended() bool {
	return p != FlowStarting && p != FlowWaiting && p != FlowFinishing
}

// FailureReason says why a flow failed, in the words a client picks its copy
// by. FlowFailure.Detail carries the rest.
type FailureReason string

const (
	// FailureExpired is a code that was not approved in time.
	FailureExpired FailureReason = "expired"
	// FailureDeclined is a code the user declined in the browser.
	FailureDeclined FailureReason = "declined"
	FailureOther    FailureReason = "other"
)

// Flow is one link flow, as a client sees it. The device code and the machine
// token never appear here: they stay in this process.
type Flow struct {
	ID string `json:"id"`
	// Revision grows with every change to any flow: one counter for all of a
	// process's flows. A reply and a change notification travel separately
	// and can arrive in either order, so a client keeps whichever copy has
	// the higher revision — of the same flow or of another, since a newer
	// flow's copies are always above an older one's. Only copies from the
	// same process compare: revisions restart with it.
	Revision  int64     `json:"revision"`
	Phase     FlowPhase `json:"phase"`
	StartedAt time.Time `json:"started_at"`
	// ExpiresAt is when the code expires and this process ends the flow, from
	// FlowWaiting on.
	ExpiresAt time.Time `json:"expires_at,omitzero"`
	// UserCode and VerificationURL are set while FlowWaiting. Whoever has them
	// can approve the flow into their own account, so they are never logged.
	UserCode        string `json:"user_code,omitempty"`
	VerificationURL string `json:"verification_url,omitempty"`
	// CloudUnreachable is set while polling gets no answer. The flow carries
	// on: the cloud may be back before the code expires.
	CloudUnreachable bool `json:"cloud_unreachable,omitempty"`
	// Email and MachineName are the account and the name the machine is
	// listed under, with FlowLinked (when the cloud said) and FlowAlreadyLinked.
	Email       string `json:"email,omitempty"`
	MachineName string `json:"machine_name,omitempty"`
	// LeftBehind is set, with FlowAlreadyLinked or FlowFailed, when the token
	// this flow was approved for was not kept and could not be revoked either,
	// so its machine stays in the account until the user removes it on the
	// web.
	LeftBehind bool         `json:"left_behind,omitempty"`
	Failure    *FlowFailure `json:"failure,omitempty"`
}

type FlowFailure struct {
	Reason FailureReason `json:"reason"`
	Detail string        `json:"detail,omitempty"`
}

// Unlinked is what Unlink did.
type Unlinked struct {
	// WasLinked is false when there was no cloud.json to remove.
	WasLinked bool `json:"was_linked"`
	// CloudURL is the cloud the link was with — cloud.json's, which may be
	// another than this process's.
	CloudURL string `json:"cloud_url,omitempty"`
	// RevokeError is set when the cloud could not be told. The link is gone
	// here but left behind there, for the user to remove on the web.
	RevokeError string `json:"revoke_error,omitempty"`
}

// Relay is what Service needs of this process's relay; relay.Manager
// implements it.
type Relay interface {
	AccountFor(machineToken string) (relay.Account, bool)
	CheckCloudCredentials()
}

// RelayOf is m as NewService takes it: nil when the relay is disabled and m is
// nil. Passing m itself would hand the service an interface holding a nil
// pointer, which does not read as "no relay".
func RelayOf(m *relay.Manager) Relay {
	if m == nil {
		return nil
	}
	return m
}

// Listener hears that the status may have changed; Status reads what it now
// is. It is called from several goroutines at once, and from the relay while
// it holds the lock its reconnect loop and credential watcher share, so it
// must not block: wake something else to do the work.
type Listener interface {
	OnCloudLinkChange()
}

var (
	ErrFlowNotFound = errors.New("no such link flow; it may have been replaced by a newer one")
	ErrShuttingDown = errors.New("the server is shutting down")
)

var errFlowCanceled = errors.New("link flow canceled")

const (
	// fallbackLifetime bounds a flow whose cloud names no expires_in, though
	// RFC 8628 requires one: a flow nobody finishes must still end, since it
	// holds the process's one slot. It is the cloud's own expires_in.
	fallbackLifetime = 10 * time.Minute
	// finishTimeout bounds deciding whether to save the token a flow was
	// approved for, and saving it — FlowFinishing, which neither a cancel nor
	// Close cuts short. It is the client's timeout for one request; deciding
	// needs no request unless another link was written meanwhile. A token
	// that is not kept is then revoked outside this bound, so that a slow
	// check does not leave it no time.
	finishTimeout = 30 * time.Second
	// cancelWait bounds how long Cancel waits for the flow to stop, so the
	// flow it returns already says so. Stopping one is cancelling a request,
	// which takes no time; this is only a backstop.
	cancelWait = 10 * time.Second
)

// Service links and unlinks this machine on behalf of a running process's UI:
// the process runs the device flow, and the UI only shows the code and the
// link. There is at most one flow per process, and it belongs to the process,
// not to the client that started it: it goes on through a reload or a dropped
// connection until it ends, it is cancelled, or the code expires. It does not
// survive a restart.
type Service struct {
	cloudURL string
	store    *cloudcred.Store
	relay    Relay
	log      *slog.Logger
	wait     waitFunc

	baseCtx    context.Context
	cancelBase context.CancelCauseFunc
	// runningWG is the flow and any Unlink under way, which Close waits for.
	runningWG sync.WaitGroup

	// flowMu guards flow, revision and closed, and each flow's record.
	flowMu   sync.Mutex
	flow     *flowRun
	revision int64
	closed   bool

	// credentialMu keeps an Unlink from reading cloud.json just before a
	// flow saves its token and then deleting that token unrevoked.
	credentialMu sync.Mutex

	listenersMu sync.Mutex
	listeners   []Listener
}

type flowRun struct {
	flow   Flow
	cancel context.CancelCauseFunc
	// settled is closed once a cancel can no longer change how the flow
	// ends: it has ended, or it is FlowFinishing.
	settled     chan struct{}
	settledOnce sync.Once
}

func (r *flowRun) settle() {
	r.settledOnce.Do(func() { close(r.settled) })
}

// NewService links to cloudURL, this process's -cloud-url and never a
// client's. relayManager is nil when the relay is disabled (see RelayOf);
// otherwise its Config.OnAccountChange must call RelayAccountChanged.
func NewService(cloudURL string, store *cloudcred.Store, relayManager Relay, log *slog.Logger) *Service {
	ctx, cancel := context.WithCancelCause(context.Background())
	return &Service{
		cloudURL:   cloudURL,
		store:      store,
		relay:      relayManager,
		log:        log.With("module", "cloudlogin"),
		wait:       sleep,
		baseCtx:    ctx,
		cancelBase: cancel,
	}
}

// Status combines cloud.json, the relay's last account result and the latest
// flow.
func (s *Service) Status() (Status, error) {
	cred, err := s.store.Load()
	if err != nil {
		return Status{}, fmt.Errorf("read the cloud credential: %w", err)
	}
	token := cred.TokenFor(s.cloudURL)

	st := Status{CloudURL: s.cloudURL, Credential: CredentialNone, Relay: RelayDisabled}
	switch {
	case token != "":
		st.Credential = CredentialLinked
	case cred != nil:
		st.Credential, st.OtherCloudURL = CredentialOtherCloud, cred.CloudURL
	}
	if m, err := currentMachine(); err == nil {
		st.MachineName = m.name()
	}

	if s.relay != nil {
		account, settled := s.relay.AccountFor(token)
		switch {
		case !settled:
			st.Relay = RelayPending
		case account.Email != "":
			st.Relay, st.Email = RelayAttached, account.Email
		case account.LinkInvalid():
			st.Relay = RelayLinkInvalid
		case account.NotAttached():
			st.Relay = RelayNotAttached
		default:
			st.Relay = RelayGuest
		}
	}

	s.flowMu.Lock()
	if s.flow != nil {
		f := s.flow.flow
		st.Flow = &f
	}
	s.flowMu.Unlock()
	return st, nil
}

// Start starts a flow, or returns the one already running: two screens that
// both read "not linked" and both press start land in the same flow.
func (s *Service) Start() (Flow, error) {
	s.flowMu.Lock()
	if s.closed {
		s.flowMu.Unlock()
		return Flow{}, ErrShuttingDown
	}
	if r := s.flow; r != nil && !r.flow.Phase.Ended() {
		f := r.flow
		s.flowMu.Unlock()
		return f, nil
	}

	ctx, cancel := context.WithCancelCause(s.baseCtx)
	r := &flowRun{
		flow:    Flow{ID: uuid.NewString(), Phase: FlowStarting, StartedAt: time.Now()},
		cancel:  cancel,
		settled: make(chan struct{}),
	}
	s.revision++
	r.flow.Revision = s.revision
	s.flow = r
	f := r.flow
	// Under flowMu, which Close takes before waiting: a flow that got past the
	// closed check is always one Close waits for.
	s.runningWG.Go(func() {
		defer cancel(nil)
		s.run(ctx, r)
	})
	s.flowMu.Unlock()

	s.log.Info("cloud link flow started", "flowId", f.ID)
	s.notify()
	return f, nil
}

// Cancel ends the flow with id. A flow that has already ended, or is
// FlowFinishing, is returned as it is: how it ends is no longer the user's
// to change.
func (s *Service) Cancel(id string) (Flow, error) {
	s.flowMu.Lock()
	r := s.flow
	found := r != nil && r.flow.ID == id
	s.flowMu.Unlock()
	if !found {
		return Flow{}, ErrFlowNotFound
	}

	r.cancel(errFlowCanceled)
	select {
	case <-r.settled:
	case <-time.After(cancelWait):
	}

	s.flowMu.Lock()
	defer s.flowMu.Unlock()
	return r.flow, nil
}

// Unlink is `pockode logout`: it revokes the stored token at the cloud that
// issued it and deletes cloud.json, even when the cloud could not be told.
// Like logout it acts on whatever cloud.json holds, a token from another
// cloud included.
//
// It takes no context: the request that asked for it may go away — a phone
// put in a pocket — but the file goes regardless, and a revoke cut short
// would only leave a link behind on the cloud for nothing. The client's
// timeout bounds it. For the same reason Close waits for it: an exit between
// the revoke and the delete would leave cloud.json holding a revoked token.
func (s *Service) Unlink() (Unlinked, error) {
	s.flowMu.Lock()
	if s.closed {
		s.flowMu.Unlock()
		return Unlinked{}, ErrShuttingDown
	}
	s.runningWG.Add(1)
	s.flowMu.Unlock()
	defer s.runningWG.Done()

	s.credentialMu.Lock()
	done, err := unlink(context.Background(), s.store)
	s.credentialMu.Unlock()
	if err != nil {
		return Unlinked{}, err
	}
	if done == nil {
		return Unlinked{}, nil
	}

	s.credentialChanged()
	result := Unlinked{WasLinked: true, CloudURL: done.cloudURL}
	if done.revokeErr != nil {
		result.RevokeError = done.revokeErr.Error()
		s.log.Warn("unlinked locally, but could not revoke the machine token", "cloudUrl", done.cloudURL, "error", done.revokeErr)
	} else {
		s.log.Info("unlinked from the cloud account", "cloudUrl", done.cloudURL)
	}
	return result, nil
}

func (s *Service) AddListener(l Listener) {
	s.listenersMu.Lock()
	defer s.listenersMu.Unlock()
	s.listeners = append(s.listeners, l)
}

// RelayAccountChanged is for the relay's Config.OnAccountChange: the relay's
// part of the status changed, which is also how a link or unlink made by
// another process shows up here.
func (s *Service) RelayAccountChanged() {
	s.notify()
}

// Close ends a running flow and waits for it, and for an Unlink under way;
// both are refused from then on. A flow that is FlowFinishing is not cut
// short: it may take finishTimeout, and a request to revoke a token it does
// not keep.
func (s *Service) Close() {
	s.flowMu.Lock()
	s.closed = true
	s.flowMu.Unlock()
	s.cancelBase(ErrShuttingDown)
	s.runningWG.Wait()
}

func (s *Service) run(ctx context.Context, r *flowRun) {
	defer r.settle()
	c := newClient(s.cloudURL)

	existing, err := checkExistingLink(ctx, s.store, c)
	if err != nil {
		s.fail(ctx, r, err, false)
		return
	}
	if existing.machine != nil {
		s.end(r, func(f *Flow) {
			f.Phase = FlowAlreadyLinked
			f.Email, f.MachineName = existing.machine.Email, existing.machine.Name
		})
		return
	}

	auth, err := authorizeDevice(ctx, c)
	if err != nil {
		s.fail(ctx, r, err, false)
		return
	}
	pollCtx, cancelPoll := withCodeLifetime(ctx, auth, fallbackLifetime)
	defer cancelPoll()
	expiresAt, _ := pollCtx.Deadline()
	s.update(r, func(f *Flow) {
		f.Phase = FlowWaiting
		f.ExpiresAt = expiresAt
		f.UserCode = auth.UserCode
		f.VerificationURL = auth.VerificationURIComplete
	})

	token, err := pollForToken(pollCtx, c, auth, s.wait, func(err error) {
		s.update(r, func(f *Flow) { f.CloudUnreachable = err != nil })
	})
	if err != nil {
		s.fail(ctx, r, err, false)
		return
	}

	// The flow now holds a token the cloud will not hand out again. Whatever
	// happens next it must end saved or revoked, so a cancel no longer
	// applies, and the code it showed is spent.
	s.update(r, func(f *Flow) {
		f.Phase = FlowFinishing
		f.UserCode, f.VerificationURL, f.CloudUnreachable = "", "", false
	})
	r.settle()
	finishCtx, cancelFinish := context.WithTimeout(context.WithoutCancel(ctx), finishTimeout)
	defer cancelFinish()
	s.finish(finishCtx, c, r, existing.token, token)
}

// finish saves token, unless a valid token for this cloud was written while
// the flow ran — by another process, or `pockode login`. Overwriting that one
// would leave its machine in the account with nothing acting for it, so this
// flow's token is the one revoked instead. replaceable is the token for this
// cloud the flow may overwrite: the one it started over, which the cloud did
// not accept.
func (s *Service) finish(ctx context.Context, c *client, r *flowRun, replaceable, token string) {
	s.credentialMu.Lock()
	other, err := s.save(ctx, c, replaceable, token)
	s.credentialMu.Unlock()
	if err != nil || other != nil {
		leftBehind := s.revokeFresh(c, token)
		if err != nil {
			s.fail(ctx, r, err, leftBehind)
			return
		}
		s.end(r, func(f *Flow) {
			f.Phase = FlowAlreadyLinked
			f.Email, f.MachineName = other.Email, other.Name
			f.LeftBehind = leftBehind
		})
		return
	}
	s.credentialChanged()

	// Only for showing whom the machine is now linked to; the link stands
	// without it.
	m, err := c.machine(ctx, token)
	if err != nil {
		s.log.Warn("linked, but could not read the account back", "error", err)
		m = &linkedMachine{}
	}
	s.end(r, func(f *Flow) {
		f.Phase = FlowLinked
		f.Email, f.MachineName = m.Email, m.Name
	})
}

// save saves token over replaceable. When a valid link was written meanwhile
// it leaves the file alone and returns that link's machine; when it cannot
// tell whether one is valid, or cannot save, it returns why.
func (s *Service) save(ctx context.Context, c *client, replaceable, token string) (*linkedMachine, error) {
	for {
		saved, current, err := s.store.SaveIfUnchanged(&cloudcred.Credential{CloudURL: s.cloudURL, MachineToken: token}, replaceable)
		if err != nil {
			return nil, fmt.Errorf("save the cloud credential: %w", err)
		}
		if saved {
			return nil, nil
		}

		// One the cloud does not accept, or none at all, is no link to keep.
		// Asking happens outside the file's lock, so the save is tried again
		// over what was asked about.
		if current != "" {
			m, err := c.machine(ctx, current)
			switch {
			case err == nil:
				return m, nil
			case !isUnauthorized(err):
				// It may be valid; never overwrite what cannot be checked.
				return nil, fmt.Errorf("check the link written while this one ran: %w", err)
			}
		}
		replaceable = current
	}
}

// revokeFresh revokes a token this flow obtained and will not keep, and
// reports whether its machine was left behind in the account. It owes nothing
// to the flow's context, which may have run out on the way here; the client's
// timeout bounds it.
func (s *Service) revokeFresh(c *client, token string) bool {
	err := c.revoke(context.Background(), token)
	if err == nil || isUnauthorized(err) {
		return false
	}
	s.log.Warn("could not revoke the machine token this link flow obtained, its machine stays in the account", "error", err)
	return true
}

// fail ends the flow over err. Why ctx ended comes first: the error is then
// only the consequence of its requests being cancelled. leftBehind is as for
// Flow.LeftBehind.
func (s *Service) fail(ctx context.Context, r *flowRun, err error, leftBehind bool) {
	if ctx.Err() != nil {
		switch cause := context.Cause(ctx); {
		case errors.Is(cause, errFlowCanceled):
			s.end(r, func(f *Flow) { f.Phase = FlowCanceled })
			return
		case errors.Is(cause, ErrShuttingDown):
			err = ErrShuttingDown
		}
	}
	failure := &FlowFailure{Reason: FailureOther, Detail: err.Error()}
	switch {
	case errors.Is(err, errCodeExpired):
		failure = &FlowFailure{Reason: FailureExpired}
	case errors.Is(err, errDeclined):
		failure = &FlowFailure{Reason: FailureDeclined}
	}
	s.end(r, func(f *Flow) {
		f.Phase = FlowFailed
		f.Failure = failure
		f.LeftBehind = leftBehind
	})
}

// end applies the flow's last change, which also clears what it showed the
// user while it ran.
func (s *Service) end(r *flowRun, change func(*Flow)) {
	s.update(r, func(f *Flow) {
		f.UserCode, f.VerificationURL, f.CloudUnreachable = "", "", false
		change(f)
	})

	s.flowMu.Lock()
	f := r.flow
	s.flowMu.Unlock()
	if f.Phase == FlowFailed {
		s.log.Warn("cloud link flow failed", "flowId", f.ID, "reason", f.Failure.Reason, "detail", f.Failure.Detail)
	} else {
		s.log.Info("cloud link flow ended", "flowId", f.ID, "phase", f.Phase)
	}
}

func (s *Service) update(r *flowRun, change func(*Flow)) {
	s.flowMu.Lock()
	change(&r.flow)
	s.revision++
	r.flow.Revision = s.revision
	s.flowMu.Unlock()
	s.notify()
}

// credentialChanged is this process having rewritten cloud.json: its relay
// re-reads it at once rather than at its next poll, and clients re-read the
// status.
func (s *Service) credentialChanged() {
	if s.relay != nil {
		s.relay.CheckCloudCredentials()
	}
	s.notify()
}

func (s *Service) notify() {
	s.listenersMu.Lock()
	listeners := s.listeners
	s.listenersMu.Unlock()
	for _, l := range listeners {
		l.OnCloudLinkChange()
	}
}
