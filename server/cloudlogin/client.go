package cloudlogin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// cloudError is a failure the cloud answered with, in its error body's shape.
type cloudError struct {
	Status  int
	Code    string `json:"error"`
	Message string `json:"message"`
}

func (e *cloudError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("cloud answered %d %s: %s", e.Status, e.Code, e.Message)
	}
	return fmt.Sprintf("cloud answered %d %s", e.Status, e.Code)
}

// Device authorization error codes (RFC 8628 §3.5).
const (
	codeAuthorizationPending = "authorization_pending"
	codeSlowDown             = "slow_down"
	codeExpiredToken         = "expired_token"
	codeAccessDenied         = "access_denied"
)

func hasCode(err error, code string) bool {
	var ce *cloudError
	return errors.As(err, &ce) && ce.Code == code
}

// errUnreachable marks a request that got no answer from the cloud at all.
var errUnreachable = errors.New("cloud unreachable")

// isTransient reports a failure that may clear up by itself: no answer, or a
// server error.
func isTransient(err error) bool {
	var ce *cloudError
	return errors.Is(err, errUnreachable) || (errors.As(err, &ce) && ce.Status >= 500)
}

func isUnauthorized(err error) bool {
	var ce *cloudError
	return errors.As(err, &ce) && ce.Status == http.StatusUnauthorized
}

// client speaks the cloud's machine-link endpoints.
type client struct {
	baseURL    string
	httpClient *http.Client
}

func newClient(baseURL string) *client {
	return &client{baseURL: baseURL, httpClient: &http.Client{Timeout: 30 * time.Second}}
}

type machineIdentity struct {
	Hostname string `json:"hostname"`
	OSUser   string `json:"os_user"`
	OS       string `json:"os"`
}

type deviceAuthorization struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	Interval                int    `json:"interval"`
	ExpiresIn               int    `json:"expires_in"`
}

// linkedMachine is the account a machine token links to and the name the
// machine is listed under.
type linkedMachine struct {
	Email string `json:"email"`
	Name  string `json:"name"`
}

func (c *client) authorize(ctx context.Context, id machineIdentity) (*deviceAuthorization, error) {
	var auth deviceAuthorization
	if err := c.do(ctx, http.MethodPost, "/api/device/authorize", "", id, &auth); err != nil {
		return nil, err
	}
	return &auth, nil
}

// token exchanges an approved device code for the machine token. Until then
// it fails with a cloudError whose Code says why.
func (c *client) token(ctx context.Context, deviceCode string) (string, error) {
	req := struct {
		DeviceCode string `json:"device_code"`
	}{deviceCode}
	var resp struct {
		MachineToken string `json:"machine_token"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/device/token", "", req, &resp); err != nil {
		return "", err
	}
	if resp.MachineToken == "" {
		return "", errors.New("cloud answered without a machine token")
	}
	return resp.MachineToken, nil
}

func (c *client) machine(ctx context.Context, machineToken string) (*linkedMachine, error) {
	var m linkedMachine
	if err := c.do(ctx, http.MethodGet, "/api/machine", machineToken, nil, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

func (c *client) revoke(ctx context.Context, machineToken string) error {
	return c.do(ctx, http.MethodPost, "/api/machine/revoke", machineToken, nil, nil)
}

// do sends body as JSON (none if nil) and decodes a 2xx answer into out (or
// discards it if nil). Any other status is returned as a *cloudError.
func (c *client) do(ctx context.Context, method, path, bearer string, body, out any) error {
	var reqBody io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
		reqBody = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reqBody)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("%w: request %s: %w", errUnreachable, path, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		ce := &cloudError{Status: resp.StatusCode}
		// A body that is not the cloud's error shape still leaves the status.
		_ = json.NewDecoder(resp.Body).Decode(ce)
		return ce
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decode %s response: %w", path, err)
	}
	return nil
}
