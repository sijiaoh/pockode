package session

import (
	"errors"
	"time"
)

var ErrSessionNotFound = errors.New("session not found")

// SessionMeta holds metadata for a chat session.
type SessionMeta struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Activated bool      `json:"activated"` // true after first message sent
}
