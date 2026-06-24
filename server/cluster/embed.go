package cluster

import "embed"

//go:embed all:static/*
var staticFS embed.FS
