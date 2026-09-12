//go:build linux

package main

import (
	"log"

	"github.com/dymoo/microvm/guest/internal/runner"
	"github.com/dymoo/microvm/guest/internal/vsock"
)

func main() {
	log.SetFlags(0)
	platform, err := runner.NewLinuxPlatform()
	if err != nil {
		log.Fatalf("guest runner isolation unavailable: %v", err)
	}
	listener, err := vsock.Listen()
	if err != nil {
		log.Fatalf("guest runner vsock unavailable: %v", err)
	}
	defer listener.Close()
	log.Printf("microvm guest runner listening on AF_VSOCK port %d", vsock.Port)
	if err := runner.NewServer(platform).Serve(listener); err != nil {
		log.Fatalf("guest runner stopped: %v", err)
	}
}
