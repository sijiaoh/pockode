package watch

import "github.com/pockode/server/cloudlogin"

// CloudLinkWatcher pushes this process's cloud link status to the clients
// following it. Notifications are cloud_link.changed.
type CloudLinkWatcher struct {
	*latestWatcher[cloudlogin.Status]
}

func NewCloudLinkWatcher(links *cloudlogin.Service) *CloudLinkWatcher {
	w := &CloudLinkWatcher{newLatestWatcher("cloud link", "cloud_link.changed", links.Status,
		func(id string, status cloudlogin.Status) any { return cloudLinkChangedParams{ID: id, Status: status} })}
	links.AddListener(w)
	return w
}

// OnCloudLinkChange implements cloudlogin.Listener.
func (w *CloudLinkWatcher) OnCloudLinkChange() { w.changed() }

type cloudLinkChangedParams struct {
	ID     string            `json:"id"`
	Status cloudlogin.Status `json:"status"`
}
