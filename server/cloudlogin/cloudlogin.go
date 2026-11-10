// Package cloudlogin links this machine to a cloud account and unlinks it,
// keeping the result in cloudcred's store. It has two front ends over one
// implementation: Linker, for `pockode login` / `pockode logout` in a
// terminal, and Service, for a running process acting on its UI's behalf.
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

	"github.com/pockode/server/cloudcred"
	"github.com/pockode/server/startup"
)

// Linker runs login and logout against one credential store, reporting to out.
type Linker struct {
	store *cloudcred.Store
	out   io.Writer
	wait  waitFunc
}

func NewLinker(store *cloudcred.Store, out io.Writer) *Linker {
	return &Linker{store: store, out: out, wait: sleep}
}

// Login links this machine to an account on cloudURL, unless it already is.
func (l *Linker) Login(ctx context.Context, cloudURL string) error {
	c := newClient(cloudURL)

	existing, err := checkExistingLink(ctx, l.store, c)
	if err != nil {
		return err
	}
	switch {
	case existing.machine != nil:
		fmt.Fprintf(l.out, "This machine is already linked to %s as %s.\n", existing.machine.Email, existing.machine.Name)
		fmt.Fprintln(l.out, "To link it to another account, run pockode logout first.")
		return nil
	case existing.token != "":
		fmt.Fprintln(l.out, "This machine's link to its cloud account is no longer valid; linking it again.")
	case existing.otherCloud != "":
		fmt.Fprintf(l.out, "This machine is linked to %s; linking it to %s instead.\n", existing.otherCloud, cloudURL)
	}

	auth, err := authorizeDevice(ctx, c)
	if err != nil {
		return err
	}
	l.showAuthorization(auth)

	pollCtx, cancel := withCodeLifetime(ctx, auth, 0)
	defer cancel()
	token, err := pollForToken(pollCtx, c, auth, l.wait, func(err error) {
		if err != nil {
			fmt.Fprintf(l.out, "Cannot reach the cloud, still trying: %v\n", err)
		}
	})
	if errors.Is(err, errCodeExpired) {
		return errExpired
	}
	if err != nil {
		return err
	}

	if err := l.store.Save(&cloudcred.Credential{CloudURL: cloudURL, MachineToken: token}); err != nil {
		return fmt.Errorf("save the cloud credential: %w", err)
	}
	fmt.Fprintln(l.out, "This machine is now linked. Running Pockode processes pick up the link within a few seconds.")
	return nil
}

var errExpired = fmt.Errorf("%w; run pockode login again", errCodeExpired)

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

// Logout unlinks this machine; see unlink for why the local credential goes
// whatever the cloud answers.
func (l *Linker) Logout(ctx context.Context) error {
	done, err := unlink(ctx, l.store)
	if err != nil {
		return err
	}
	switch {
	case done == nil:
		fmt.Fprintln(l.out, "This machine is not linked to a cloud account.")
	case done.revokeErr != nil:
		fmt.Fprintf(l.out, "Logged out locally, but could not tell %s: %v\n", done.cloudURL, done.revokeErr)
		fmt.Fprintf(l.out, "Unlink this machine from your account on the web at %s.\n", done.cloudURL)
	default:
		fmt.Fprintln(l.out, "Logged out: this machine is no longer linked to a cloud account.")
	}
	return nil
}
