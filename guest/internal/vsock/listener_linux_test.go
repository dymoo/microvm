//go:build linux

package vsock

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestListenerCloseUnblocksAccept(t *testing.T) {
	fd, err := unix.Socket(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC|unix.SOCK_NONBLOCK, 0)
	if err != nil {
		t.Fatalf("create Unix listener: %v", err)
	}
	owned := false
	defer func() {
		if !owned {
			unix.Close(fd)
		}
	}()

	path := filepath.Join(t.TempDir(), "listener.sock")
	if err := unix.Bind(fd, &unix.SockaddrUnix{Name: path}); err != nil {
		t.Fatalf("bind Unix listener: %v", err)
	}
	if err := unix.Listen(fd, 1); err != nil {
		t.Fatalf("listen on Unix socket: %v", err)
	}
	file := os.NewFile(uintptr(fd), "test-listener")
	if file == nil {
		t.Fatal("wrap Unix listener")
	}
	owned = true
	listener := &listener{file: file, port: ExecPort}
	defer listener.Close()

	started := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		close(started)
		connection, err := listener.Accept()
		if connection != nil {
			connection.Close()
		}
		result <- err
	}()
	<-started

	select {
	case err := <-result:
		t.Fatalf("accept returned before close: %v", err)
	case <-time.After(25 * time.Millisecond):
	}

	if err := listener.Close(); err != nil {
		t.Fatalf("close listener: %v", err)
	}
	select {
	case err := <-result:
		if !errors.Is(err, net.ErrClosed) {
			t.Fatalf("accept error after close = %v, want net.ErrClosed", err)
		}
	case <-time.After(time.Second):
		t.Fatal("close did not unblock accept")
	}
}
