package cloudlogin

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/user"
	"runtime"
	"time"

	"github.com/pockode/server/cloudcred"
)

// The steps of linking and unlinking, shared by the terminal's Linker and the
// running process's Service so that the two cannot drift apart. They report
// through return values only; what the user is told is the front end's.

// RFC 8628: the interval when the cloud names none (§3.2), and how much each
// slow_down adds to it (§3.5).
const (
	defaultInterval = 5 * time.Second
	slowDownStep    = 5 * time.Second
)

var (
	errCodeExpired = errors.New("the link code expired before it was approved")
	errDeclined    = errors.New("linking was declined in the browser")
)

// waitFunc sleeps between polls; tests replace it to run the flow at once.
type waitFunc func(ctx context.Context, d time.Duration) error

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// existingLink is what cloud.json says about this machine's link, as seen by
// one cloud.
type existingLink struct {
	// token is the stored machine token if this cloud issued it, else "".
	token string
	// machine is set when the cloud accepted token.
	machine *linkedMachine
	// otherCloud is the cloud that issued the stored token, when it is not
	// this one.
	otherCloud string
}

// checkExistingLink asks the cloud about a token it issued. A token issued by
// another cloud is never shown to this one.
func checkExistingLink(ctx context.Context, store *cloudcred.Store, c *client) (existingLink, error) {
	cred, err := store.Load()
	if err != nil {
		return existingLink{}, fmt.Errorf("read the cloud credential: %w", err)
	}
	token := cred.TokenFor(c.baseURL)
	if token == "" {
		if cred == nil {
			return existingLink{}, nil
		}
		return existingLink{otherCloud: cred.CloudURL}, nil
	}

	m, err := c.machine(ctx, token)
	switch {
	case err == nil:
		return existingLink{token: token, machine: m}, nil
	case isUnauthorized(err):
		return existingLink{token: token}, nil
	default:
		return existingLink{}, fmt.Errorf("check the existing link with %s: %w", c.baseURL, err)
	}
}

func authorizeDevice(ctx context.Context, c *client) (*deviceAuthorization, error) {
	id, err := currentMachine()
	if err != nil {
		return nil, err
	}
	auth, err := c.authorize(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("start linking with %s: %w", c.baseURL, err)
	}
	return auth, nil
}

// withCodeLifetime bounds ctx by the code's lifetime, expires_in from now, or
// fallback when the cloud names none (no bound for 0). pollForToken reads that
// deadline running out as the code expiring.
func withCodeLifetime(ctx context.Context, auth *deviceAuthorization, fallback time.Duration) (context.Context, context.CancelFunc) {
	lifetime := time.Duration(auth.ExpiresIn) * time.Second
	if lifetime <= 0 {
		lifetime = fallback
	}
	if lifetime <= 0 {
		return context.WithCancel(ctx)
	}
	return context.WithTimeout(ctx, lifetime)
}

// pollForToken polls until the user approves auth, and returns the machine
// token the approval turned into. ctx carries the code's lifetime
// (withCodeLifetime).
//
// onReachability, if set, hears when the cloud stops answering (a non-nil
// error) and when it answers again (nil) — once per change, not every poll.
// The cloud may be back before the code expires, so an outage alone does not
// end the flow.
func pollForToken(ctx context.Context, c *client, auth *deviceAuthorization, wait waitFunc, onReachability func(error)) (string, error) {
	interval := time.Duration(auth.Interval) * time.Second
	if interval <= 0 {
		interval = defaultInterval
	}
	unreachable := false
	reachability := func(err error) {
		if unreachable == (err != nil) {
			return
		}
		unreachable = err != nil
		if onReachability != nil {
			onReachability(err)
		}
	}
	for {
		if err := wait(ctx, interval); err != nil {
			return "", expiredOr(err)
		}

		token, err := c.token(ctx, auth.DeviceCode)
		switch {
		case err == nil:
			reachability(nil)
			return token, nil
		case hasCode(err, codeAuthorizationPending):
		case hasCode(err, codeSlowDown):
			interval += slowDownStep
		case hasCode(err, codeExpiredToken):
			return "", errCodeExpired
		case hasCode(err, codeAccessDenied):
			return "", errDeclined
		case ctx.Err() != nil:
			return "", expiredOr(ctx.Err())
		case isTransient(err):
			reachability(err)
			continue
		default:
			return "", fmt.Errorf("linking failed: %w", err)
		}
		reachability(nil)
	}
}

// expiredOr reads ctx's deadline as the code expiring; any other end of ctx
// is returned as it is.
func expiredOr(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return errCodeExpired
	}
	return err
}

// unlinked is what unlink did: nil when there was no link.
type unlinked struct {
	// cloudURL is the cloud the link was with — cloud.json's, not the
	// caller's, since a token is revoked where it was issued.
	cloudURL string
	// revokeErr is why the cloud could not be told; the link is then left
	// behind there, for the user to remove on the web.
	revokeErr error
}

// unlink revokes the stored token and deletes cloud.json. The local
// credential goes regardless of whether the cloud could be told: the user
// asked for this machine to stop acting for the account, and a link left
// behind can be removed on the web.
func unlink(ctx context.Context, store *cloudcred.Store) (*unlinked, error) {
	cred, err := store.Load()
	if err != nil {
		return nil, fmt.Errorf("read the cloud credential: %w", err)
	}
	if cred == nil {
		return nil, nil
	}

	revokeErr := newClient(cred.CloudURL).revoke(ctx, cred.MachineToken)
	// 401 means the cloud no longer knows the token: already unlinked.
	if isUnauthorized(revokeErr) {
		revokeErr = nil
	}

	if err := store.Delete(); err != nil {
		return nil, fmt.Errorf("delete the cloud credential: %w", err)
	}
	return &unlinked{cloudURL: cred.CloudURL, revokeErr: revokeErr}, nil
}

// currentMachine is what the cloud names this machine by (os_user@hostname).
func currentMachine() (machineIdentity, error) {
	hostname, err := os.Hostname()
	if err != nil {
		return machineIdentity{}, fmt.Errorf("get hostname: %w", err)
	}
	u, err := user.Current()
	if err != nil {
		return machineIdentity{}, fmt.Errorf("get current user: %w", err)
	}
	return machineIdentity{Hostname: hostname, OSUser: u.Username, OS: runtime.GOOS}, nil
}
