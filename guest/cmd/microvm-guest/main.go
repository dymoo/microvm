//go:build linux

package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/dymoo/microvm/guest/internal/runner"
	"github.com/dymoo/microvm/guest/internal/vsock"
)

type serverResult struct {
	name string
	err  error
}

func main() {
	log.SetFlags(0)
	platform, err := runner.NewLinuxPlatform()
	if err != nil {
		log.Fatalf("guest runner isolation unavailable: %v", err)
	}
	execListener, err := vsock.ListenExec()
	if err != nil {
		log.Fatalf("guest runner exec vsock unavailable: %v", err)
	}
	defer execListener.Close()
	serviceListener, err := vsock.ListenService()
	if err != nil {
		log.Fatalf("guest runner service vsock unavailable: %v", err)
	}
	defer serviceListener.Close()

	serviceController := runner.NewServiceController(platform)
	defer func() {
		if err := serviceController.Close(); err != nil {
			log.Printf("guest service shutdown failure: %v", err)
		}
	}()

	results := make(chan serverResult, 2)
	go func() {
		results <- serverResult{name: "exec", err: runner.NewServer(platform).Serve(execListener)}
	}()
	go func() {
		results <- serverResult{name: "service", err: serviceController.Serve(serviceListener)}
	}()
	log.Printf("microvm guest runner listening on AF_VSOCK ports %d and %d", vsock.ExecPort, vsock.ServicePort)

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	defer signal.Stop(signals)
	select {
	case received := <-signals:
		_ = execListener.Close()
		_ = serviceListener.Close()
		if err := serviceController.Close(); err != nil {
			log.Printf("guest service shutdown failure: %v", err)
		}
		log.Printf("microvm guest runner stopping after %s", received)
	case result := <-results:
		_ = execListener.Close()
		_ = serviceListener.Close()
		if result.err != nil {
			log.Printf("%s listener stopped: %v", result.name, result.err)
		} else {
			log.Printf("%s listener stopped unexpectedly", result.name)
		}
	}
}
