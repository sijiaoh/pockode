// Package cloudlogin links this machine to a cloud account (pockode login)
// and unlinks it (pockode logout), keeping the result in cloudcred's store.
//
// Linking is the OAuth device authorization grant (RFC 8628): the cloud hands
// out a code, the user approves it in a browser where they are signed in, and
// this side polls until the approval turns into a machine token.
package cloudlogin

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"runtime"
	"time"

	"github.com/pockode/server/cloudcred"
	"github.com/pockode/server/startup"
)

// RFC 8628: the interval when the cloud names none (§3.2), and how much each
// slow_down adds to it (§3.5).
const (
	defaultInterval = 5 * time.Second
	slowDownStep    = 5 * time.Second
)

// Linker runs login and logout against one credential store, reporting to out.
type Linker struct {
	store *cloudcred.Store
	out   io.Writer

	// wait sleeps between polls; tests replace it to run the flow at once.
	wait func(ctx context.Context, d time.Duration) error
}

func NewLinker(store *cloudcred.Store, out io.Writer) *Linker {
	return &Linker{store: store, out: out, wait: sleep}
}

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

// Login links this machine to an account on cloudURL, unless it already is.
func (l *Linker) Login(ctx context.Context, cloudURL string) error {
	c := newClient(cloudURL)

	existing, err := l.store.MachineToken(cloudURL)
	if err != nil {
		return fmt.Errorf("read the cloud credential: %w", err)
	}
	if existing != "" {
		m, err := c.machine(ctx, existing)
		switch {
		case err == nil:
			fmt.Fprintf(l.out, "This machine is already linked to %s as %s.\n", m.Email, m.Name)
			fmt.Fprintln(l.out, "To link it to another account, run pockode logout first.")
			return nil
		case isUnauthorized(err):
			fmt.Fprintln(l.out, "This machine's link to its cloud account is no longer valid; linking it again.")
		default:
			return fmt.Errorf("check the existing link with %s: %w", cloudURL, err)
		}
	} else if cred, err := l.store.Load(); err == nil && cred != nil {
		fmt.Fprintf(l.out, "This machine is linked to %s; linking it to %s instead.\n", cred.CloudURL, cloudURL)
	}

	id, err := currentMachine()
	if err != nil {
		return err
	}
	auth, err := c.authorize(ctx, id)
	if err != nil {
		return fmt.Errorf("start linking with %s: %w", cloudURL, err)
	}
	l.showAuthorization(auth)

	token, err := l.poll(ctx, c, auth)
	if err != nil {
		return err
	}

	if err := l.store.Save(&cloudcred.Credential{CloudURL: cloudURL, MachineToken: token}); err != nil {
		return fmt.Errorf("save the cloud credential: %w", err)
	}
	fmt.Fprintln(l.out, "This machine is now linked. Running Pockode processes pick up the link within a few seconds.")
	return nil
}

func (l *Linker) showAuthorization(auth *deviceAuthorization) {
	fmt.Fprintln(l.out, "To link this machine to your cloud account, open this link where you are signed in:")
	fmt.Fprintln(l.out)
	fmt.Fprintf(l.out, "    %s\n", auth.VerificationURIComplete)
	fmt.Fprintln(l.out)
	startup.WriteQRCode(l.out, auth.VerificationURIComplete, "Scan to link")
	fmt.Fprintln(l.out)
	fmt.Fprintf(l.out, "Approve only if the page shows the code %s.\n", formatUserCode(auth.UserCode))
	fmt.Fprintln(l.out, "Waiting for approval... (Ctrl+C to cancel)")
}

// formatUserCode splits an eight-character code in two, as RFC 8628 §6.1
// suggests for readability; the cloud ignores the dash when comparing.
func formatUserCode(code string) string {
	if len(code) != 8 {
		return code
	}
	return code[:4] + "-" + code[4:]
}

func (l *Linker) poll(ctx context.Context, c *client, auth *deviceAuthorization) (string, error) {
	interval := time.Duration(auth.Interval) * time.Second
	if interval <= 0 {
		interval = defaultInterval
	}
	if auth.ExpiresIn > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(auth.ExpiresIn)*time.Second)
		defer cancel()
	}

	unreachable := false
	for {
		if err := l.wait(ctx, interval); err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				return "", errExpired
			}
			return "", err
		}

		token, err := c.token(ctx, auth.DeviceCode)
		switch {
		case err == nil:
			return token, nil
		case hasCode(err, codeAuthorizationPending):
		case hasCode(err, codeSlowDown):
			interval += slowDownStep
		case hasCode(err, codeExpiredToken):
			return "", errExpired
		case hasCode(err, codeAccessDenied):
			return "", errors.New("linking was declined in the browser")
		case ctx.Err() != nil:
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return "", errExpired
			}
			return "", ctx.Err()
		case isTransient(err):
			// The cloud may be back before the code expires, so keep polling,
			// and say so once rather than on every poll.
			if !unreachable {
				fmt.Fprintf(l.out, "Cannot reach the cloud, still trying: %v\n", err)
			}
			unreachable = true
			continue
		default:
			return "", fmt.Errorf("linking failed: %w", err)
		}
		unreachable = false
	}
}

var errExpired = errors.New("the link code expired before it was approved; run pockode login again")

// Logout unlinks this machine. The local credential goes regardless of
// whether the cloud could be told: the user asked for this machine to stop
// acting for the account, and a link left behind can be removed on the web.
func (l *Linker) Logout(ctx context.Context) error {
	cred, err := l.store.Load()
	if err != nil {
		return fmt.Errorf("read the cloud credential: %w", err)
	}
	if cred == nil {
		fmt.Fprintln(l.out, "This machine is not linked to a cloud account.")
		return nil
	}

	revokeErr := newClient(cred.CloudURL).revoke(ctx, cred.MachineToken)
	// 401 means the cloud no longer knows the token: already unlinked.
	if isUnauthorized(revokeErr) {
		revokeErr = nil
	}

	if err := l.store.Delete(); err != nil {
		return fmt.Errorf("delete the cloud credential: %w", err)
	}

	if revokeErr != nil {
		fmt.Fprintf(l.out, "Logged out locally, but could not tell %s: %v\n", cred.CloudURL, revokeErr)
		fmt.Fprintf(l.out, "Unlink this machine from your account on the web at %s.\n", cred.CloudURL)
		return nil
	}
	fmt.Fprintln(l.out, "Logged out: this machine is no longer linked to a cloud account.")
	return nil
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
