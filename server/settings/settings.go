// Package settings provides server-side settings management.
package settings

type Settings struct {
	Sandbox bool `json:"sandbox"`
}

func Default() Settings {
	return Settings{
		Sandbox: false,
	}
}
