//go:build linux

package main

import (
	"flag"
	"log"
	"os"

	"github.com/dymoo/microvm/guest/internal/httpproxy"
	"github.com/dymoo/microvm/guest/internal/vsock"
)

const (
	proxyUID = 1001
	proxyGID = 1001
)

func main() {
	log.SetFlags(0)
	port := flag.Int("port", 0, "immutable loopback web service port")
	flag.Parse()
	if flag.NArg() != 0 {
		log.Fatal("microvm-http-proxy accepts only --port")
	}
	if os.Geteuid() != proxyUID || os.Getegid() != proxyGID {
		log.Fatalf("microvm-http-proxy must run as UID/GID %d", proxyUID)
	}
	server, err := httpproxy.New(*port)
	if err != nil {
		log.Fatalf("invalid web proxy configuration: %v", err)
	}
	listener, err := vsock.ListenHTTP()
	if err != nil {
		log.Fatalf("guest HTTP proxy vsock unavailable: %v", err)
	}
	defer listener.Close()
	log.Printf("microvm HTTP proxy listening on AF_VSOCK port %d", vsock.HTTPPort)
	if err := server.Serve(listener); err != nil {
		log.Fatalf("guest HTTP proxy stopped: %v", err)
	}
}
