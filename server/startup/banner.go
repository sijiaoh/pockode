package startup

import (
	"bytes"
	"fmt"
	"os"
	"strings"

	"github.com/mdp/qrterminal/v3"
	"golang.org/x/term"
)

const (
	// ANSI color codes
	reset = "\033[0m"
	bold  = "\033[1m"
	dim   = "\033[2m"
	cyan  = "\033[36m"
	green = "\033[32m"
	white = "\033[37m"

	indent = "    "
)

// BannerOptions configures the startup banner display.
type BannerOptions struct {
	Version      string
	LocalURL     string
	RemoteURL    string // Empty if relay is disabled
	Announcement string // Message from cloud
	Mode         string // Running mode (e.g., "Single Workspace", "Multi-Workspace Manager")
	ModeTip      string // Helpful tip about the current mode
}

// colorsEnabled returns true if ANSI colors should be used.
func colorsEnabled() bool {
	if os.Getenv("NO_COLOR") != "" {
		return false
	}
	return term.IsTerminal(int(os.Stdout.Fd()))
}

// color wraps text with ANSI color codes if colors are enabled.
func color(code, text string) string {
	if !colorsEnabled() {
		return text
	}
	return code + text + reset
}

// PrintBanner displays the startup banner with the given options.
func PrintBanner(opts BannerOptions) {
	fmt.Println()

	logo := color(cyan, "◆") + "  " + color(bold+white, "P O C K O D E")
	versionStr := color(dim, opts.Version)
	fmt.Printf("%s%s%s%s\n", indent, logo, strings.Repeat(" ", 30), versionStr)

	if opts.Announcement != "" {
		fmt.Println()
		for _, line := range strings.Split(opts.Announcement, "\n") {
			fmt.Printf("%s%s\n", indent, line)
		}
	}

	fmt.Println()

	fmt.Printf("%s%s  %s\n", indent, color(dim, "▸ Local"), color(green, opts.LocalURL))
	if opts.RemoteURL != "" {
		fmt.Printf("%s%s %s\n", indent, color(dim, "▸ Remote"), color(green, opts.RemoteURL))
	}

	if opts.Mode != "" {
		fmt.Printf("%s%s   %s\n", indent, color(dim, "▸ Mode"), opts.Mode)
	}
	if opts.ModeTip != "" {
		fmt.Printf("%s%s   %s\n", indent, color(dim, "▸ Tip"), color(dim, opts.ModeTip))
	}

	fmt.Println()
}

// PrintQRCode prints an indented QR code with a label on the side.
func PrintQRCode(url string) {
	var buf bytes.Buffer
	qrterminal.GenerateWithConfig(url, qrterminal.Config{
		Level:          qrterminal.L,
		Writer:         &buf,
		HalfBlocks:     true,
		BlackChar:      qrterminal.BLACK_BLACK,
		WhiteBlackChar: qrterminal.WHITE_BLACK,
		WhiteChar:      qrterminal.WHITE_WHITE,
		BlackWhiteChar: qrterminal.BLACK_WHITE,
		QuietZone:      1,
	})

	var lines []string
	for _, line := range strings.Split(buf.String(), "\n") {
		if line != "" {
			lines = append(lines, line)
		}
	}

	// Place label at vertical center of QR code
	midLine := len(lines) / 2
	for i, line := range lines {
		if i == midLine {
			fmt.Printf("%s%s  %s\n", indent, line, color(dim, "Scan to connect"))
		} else {
			fmt.Printf("%s%s\n", indent, line)
		}
	}
}

// PrintFooter prints the footer with shutdown instructions.
func PrintFooter() {
	fmt.Printf("%s%s\n", indent, color(dim, "Press Ctrl+C to stop"))
	fmt.Println()
}
