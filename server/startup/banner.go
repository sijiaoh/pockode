package startup

import (
	"bytes"
	"fmt"
	"os"
	"strings"

	"github.com/mdp/qrterminal/v3"
	"golang.org/x/term"

	"github.com/pockode/server/agent"
)

const (
	// ANSI color codes
	reset  = "\033[0m"
	bold   = "\033[1m"
	dim    = "\033[2m"
	cyan   = "\033[36m"
	green  = "\033[32m"
	white  = "\033[37m"
	yellow = "\033[33m"

	indent = "    "
)

// BannerOptions configures the startup banner display.
type BannerOptions struct {
	Version      string
	LocalURL     string
	RemoteURL    string               // Empty if relay is disabled
	Announcement string               // Message from cloud
	Agents       []agent.BinaryStatus // AI CLI availability; omitted when empty
	NoColor      bool                 // Disable ANSI color output
}

// noColorSet is set by PrintBanner and used by subsequent Print* calls.
var noColorSet bool

// colorsEnabled returns true if ANSI colors should be used.
func colorsEnabled() bool {
	if noColorSet {
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
	noColorSet = opts.NoColor
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

	for _, line := range agentLines(opts.Agents) {
		fmt.Println(line)
	}

	fmt.Println()
}

// agentLines renders AI CLI availability for the banner.
//
// How loud this gets is decided by what is missing, because the two cases are
// not the same problem. One CLI missing while another works is a fact to note
// in passing — the user may well have installed only the one they use. Nothing
// found at all means no session can run, and the user is otherwise told that
// only when they start one and it fails, which can be days after the install
// step it points back to. Neither case stops pockode from starting.
func agentLines(agents []agent.BinaryStatus) []string {
	if len(agents) == 0 {
		return nil
	}

	var labels, missing []string
	for _, a := range agents {
		if a.Found() {
			labels = append(labels, color(green, a.Name))
			continue
		}
		missing = append(missing, a.Name)
		labels = append(labels, color(yellow, a.Name+" (not found)"))
	}

	lines := []string{fmt.Sprintf("%s%s %s", indent, color(dim, "▸ Agents"), strings.Join(labels, "  "))}
	if len(missing) < len(agents) {
		return lines
	}
	return append(lines,
		"",
		fmt.Sprintf("%s%s", indent, color(bold+yellow, "⚠ No AI CLI found — sessions cannot start")),
		fmt.Sprintf("%s%s", indent, color(dim, "  Install "+strings.Join(missing, " or ")+", then restart pockode")),
	)
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
