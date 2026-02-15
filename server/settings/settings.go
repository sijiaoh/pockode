// Package settings provides server-side settings management.
package settings

type Settings struct {
	Autorun bool `json:"autorun"`
}

func Default() Settings {
	return Settings{}
}
