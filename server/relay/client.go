package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"
)

var ErrInvalidToken = errors.New("invalid relay token")
var ErrUpgradeRequired = errors.New("client version too old, please upgrade Pockode")

// errRequestRefused is the cloud refusing the request body: 400 for a field it
// will not take, 413 for a body over its size cap. A guest's body is never
// refused; one carrying an account attachment can be (see Manager.call).
var errRequestRefused = errors.New("cloud refused the request body")

type Client struct {
	baseURL       string
	clientVersion string
	httpClient    *http.Client
}

func NewClient(baseURL string) *Client {
	return NewClientWithVersion(baseURL, "")
}

func NewClientWithVersion(baseURL, version string) *Client {
	return &Client{
		baseURL:       baseURL,
		clientVersion: version,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// Registration is what register and refresh answer: the relay's credentials,
// and what became of the account attachment the request carried.
type Registration struct {
	StoredConfig
	Account
}

// Register creates a relay; attach is nil for a guest.
func (c *Client) Register(ctx context.Context, attach *Attachment) (*Registration, error) {
	body := struct {
		ClientVersion string `json:"client_version"`
		*Attachment
	}{c.clientVersion, attach}
	return c.post(ctx, "/api/relay/register", body, http.StatusCreated)
}

func (c *Client) GetAnnouncement(ctx context.Context) string {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/api/announcement", nil)
	if err != nil {
		return ""
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return ""
	}

	var ann struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&ann); err != nil {
		return ""
	}

	return ann.Message
}

// Refresh confirms relayToken and returns the relay's current credentials;
// attach is nil for a guest, which leaves the relay's account as it was.
func (c *Client) Refresh(ctx context.Context, relayToken string, attach *Attachment) (*Registration, error) {
	body := struct {
		RelayToken    string `json:"relay_token"`
		ClientVersion string `json:"client_version"`
		*Attachment
	}{relayToken, c.clientVersion, attach}
	return c.post(ctx, "/api/relay/refresh", body, http.StatusOK)
}

func (c *Client) post(ctx context.Context, path string, body any, wantStatus int) (*Registration, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("encode request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case wantStatus:
	case http.StatusForbidden:
		return nil, ErrUpgradeRequired
	case http.StatusUnauthorized:
		return nil, ErrInvalidToken
	case http.StatusBadRequest, http.StatusRequestEntityTooLarge:
		return nil, fmt.Errorf("%w: status %d", errRequestRefused, resp.StatusCode)
	default:
		return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	var reg Registration
	if err := json.NewDecoder(resp.Body).Decode(&reg); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	return &reg, nil
}
