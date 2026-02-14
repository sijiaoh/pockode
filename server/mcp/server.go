package mcp

import (
	"log"
	"os"

	"github.com/mark3labs/mcp-go/server"
	"github.com/pockode/server/ticket"
)

type Server struct {
	ticketStore ticket.Store
	roleStore   ticket.RoleStore
	mcpServer   *server.MCPServer
}

func New(ticketStore ticket.Store, roleStore ticket.RoleStore) *Server {
	s := &Server{
		ticketStore: ticketStore,
		roleStore:   roleStore,
	}
	s.mcpServer = server.NewMCPServer(
		"pockode-ticket",
		"1.0.0",
		server.WithToolCapabilities(false),
		server.WithRecovery(),
	)
	s.registerTools()
	return s
}

func (s *Server) Run() error {
	log.SetOutput(os.Stderr) // stdout is reserved for JSON-RPC
	return server.ServeStdio(s.mcpServer)
}

func RunMCPServer(dataDir string) error {
	ticketStore, err := ticket.NewFileStore(dataDir)
	if err != nil {
		return err
	}
	roleStore, err := ticket.NewFileRoleStore(dataDir)
	if err != nil {
		return err
	}
	return New(ticketStore, roleStore).Run()
}
