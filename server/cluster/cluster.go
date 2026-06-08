package cluster

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/pockode/server/cluster/node"
	"github.com/pockode/server/internal/netutil"
	"github.com/pockode/server/logger"
	"github.com/pockode/server/relay"
	"github.com/pockode/server/startup"
)

const DefaultPort = 9871

type Config struct {
	Port         int
	AuthToken    string
	DataDir      string
	RelayEnabled bool
	CloudURL     string
	Version      string
	DevMode      bool
}

func Run(cfg Config) error {
	if cfg.AuthToken == "" {
		return fmt.Errorf("AUTH_TOKEN is required")
	}

	logger.Init(logger.Config{
		DataDir: cfg.DataDir,
		DevMode: cfg.DevMode,
	})

	port := netutil.FindAvailablePort(cfg.Port)

	log := slog.Default().With("mode", "cluster")
	log.Info("starting cluster mode", "port", port, "dataDir", cfg.DataDir, "relayEnabled", cfg.RelayEnabled, "devMode", cfg.DevMode)

	nodeStore, err := node.NewFileStore(cfg.DataDir)
	if err != nil {
		return fmt.Errorf("failed to create node store: %w", err)
	}

	wsHandler := newWSHandler(cfg.AuthToken, cfg.Version, cfg.DevMode, nodeStore, log)
	handler := newHandler(cfg.AuthToken, cfg.DevMode, wsHandler)

	srv := &http.Server{
		Addr:    ":" + strconv.Itoa(port),
		Handler: handler,
	}

	var relayManager *relay.Manager
	var cancelRelayStreams context.CancelFunc
	var remoteURL string
	if cfg.RelayEnabled {
		relayCfg := relay.Config{
			CloudURL:      cfg.CloudURL,
			DataDir:       cfg.DataDir,
			ClientVersion: cfg.Version,
		}

		frontendPort := port
		if envFrontendPort := os.Getenv("RELAY_FRONTEND_PORT"); envFrontendPort != "" {
			if p, err := strconv.Atoi(envFrontendPort); err == nil {
				frontendPort = p
			} else {
				log.Warn("invalid RELAY_FRONTEND_PORT, using server port", "value", envFrontendPort, "default", port)
			}
		}
		relayManager = relay.NewManager(relayCfg, port, frontendPort, log)

		var err error
		remoteURL, err = relayManager.Start(context.Background())
		if err != nil {
			return fmt.Errorf("failed to start relay: %w", err)
		}
		log.Info("remote access enabled", "url", remoteURL)

		var relayStreamCtx context.Context
		relayStreamCtx, cancelRelayStreams = context.WithCancel(context.Background())
		go func() {
			for stream := range relayManager.NewStreams() {
				go wsHandler.handleStream(relayStreamCtx, stream, stream.ConnectionID())
			}
		}()
	}

	// Fetch announcement from cloud
	announcement := relay.NewClient(cfg.CloudURL).GetAnnouncement(context.Background())

	// Display startup banner
	localURL := fmt.Sprintf("http://localhost:%d", port)
	startup.PrintBanner(startup.BannerOptions{
		Version:      cfg.Version,
		LocalURL:     localURL,
		RemoteURL:    remoteURL,
		Announcement: announcement,
	})

	// Print QR code if relay is enabled
	if remoteURL != "" {
		startup.PrintQRCode(remoteURL)
		fmt.Println()
	}

	startup.PrintFooter()

	shutdownDone := make(chan struct{})
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		signal.Stop(sigCh)

		log.Info("shutting down cluster server")
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			log.Error("server shutdown error", "error", err)
		}
		if relayManager != nil {
			if cancelRelayStreams != nil {
				cancelRelayStreams()
			}
			relayManager.Stop()
		}
		close(shutdownDone)
	}()

	log.Info("cluster server started", "addr", srv.Addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("server error: %w", err)
	}
	<-shutdownDone
	log.Info("cluster server stopped")
	return nil
}
