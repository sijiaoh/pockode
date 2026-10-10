// Prints pockode's startup banner and QR code as the terminal in the demo
// video's first shot shows them (docs/marketing-assets.md §3.3): the real
// startup.PrintBanner and startup.PrintQRCode, so the video cannot drift from
// what pockode prints. It lives in this module, not beside the video, so that
// the server's CI builds and vets it against the startup package it calls.
// scripts/ui-walkthrough/marketing/video/render.mjs builds it from server/ and
// runs it under a pseudo-terminal, so the banner keeps its colours:
//
//	go build -o banner ./internal/cmd/marketingbanner
//	script -qec './banner <version>' /dev/null
package main

import (
	"fmt"
	"os"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/startup"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: banner <version>")
		os.Exit(2)
	}
	startup.PrintBanner(startup.BannerOptions{
		Version:   os.Args[1],
		LocalURL:  "http://localhost:9870",
		RemoteURL: "https://your-pc.cloud.pockode.com",
		Agents:    []agent.BinaryStatus{{Name: "claude"}, {Name: "codex"}},
	})
	// The site, not the Remote line: whoever scans the video lands on
	// pockode.com, not on somebody's relay.
	startup.PrintQRCode("https://pockode.com")
}
