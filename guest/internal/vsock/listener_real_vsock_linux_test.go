//go:build linux && realvsock

package vsock

import (
	"errors"
	"io"
	"net"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

type acceptResult struct {
	connection net.Conn
	err        error
}

type readResult struct {
	count int
	err   error
}

func TestListenerRejectsLocalVSOCKPeer(t *testing.T) {
	listener, err := ListenExec()
	if err != nil {
		t.Fatalf("listen on AF_VSOCK port %d: %v", ExecPort, err)
	}
	defer listener.Close()

	accepted := make(chan acceptResult, 1)
	go func() {
		connection, err := listener.Accept()
		accepted <- acceptResult{connection: connection, err: err}
	}()

	clientFD, err := unix.Socket(
		unix.AF_VSOCK,
		unix.SOCK_STREAM|unix.SOCK_CLOEXEC|unix.SOCK_NONBLOCK,
		0,
	)
	if err != nil {
		t.Fatalf("create AF_VSOCK client: %v", err)
	}
	clientOwned := false
	defer func() {
		if !clientOwned {
			unix.Close(clientFD)
		}
	}()
	if err := unix.Bind(clientFD, &unix.SockaddrVM{
		CID:  unix.VMADDR_CID_LOCAL,
		Port: unix.VMADDR_PORT_ANY,
	}); err != nil {
		t.Fatalf("bind AF_VSOCK client to CID_LOCAL: %v", err)
	}

	connectErr := unix.Connect(clientFD, &unix.SockaddrVM{
		CID:  unix.VMADDR_CID_LOCAL,
		Port: ExecPort,
	})
	if errors.Is(connectErr, unix.EINPROGRESS) {
		pollFDs := []unix.PollFd{{Fd: int32(clientFD), Events: unix.POLLOUT}}
		ready, pollErr := unix.Poll(pollFDs, 1_000)
		if pollErr != nil {
			t.Fatalf("wait for AF_VSOCK loopback connection: %v", pollErr)
		}
		if ready != 1 {
			t.Fatalf("AF_VSOCK loopback connection readiness = %d, want 1", ready)
		}
		socketErr, err := unix.GetsockoptInt(clientFD, unix.SOL_SOCKET, unix.SO_ERROR)
		if err != nil {
			t.Fatalf("read AF_VSOCK connection result: %v", err)
		}
		if socketErr != 0 {
			t.Fatalf("connect to AF_VSOCK CID_LOCAL:%d: %v", ExecPort, unix.Errno(socketErr))
		}
	} else if connectErr != nil {
		t.Fatalf("connect to AF_VSOCK CID_LOCAL:%d: %v", ExecPort, connectErr)
	}

	localAddress, err := unix.Getsockname(clientFD)
	if err != nil {
		t.Fatalf("read AF_VSOCK client address: %v", err)
	}
	localVMAddress, ok := localAddress.(*unix.SockaddrVM)
	if !ok {
		t.Fatalf("AF_VSOCK client address type = %T, want *unix.SockaddrVM", localAddress)
	}
	if localVMAddress.CID != unix.VMADDR_CID_LOCAL {
		t.Fatalf("AF_VSOCK client CID = %d, want CID_LOCAL %d", localVMAddress.CID, unix.VMADDR_CID_LOCAL)
	}

	client := os.NewFile(uintptr(clientFD), "vsock-local-client")
	if client == nil {
		t.Fatal("wrap AF_VSOCK client")
	}
	clientOwned = true
	defer client.Close()
	if err := client.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("set AF_VSOCK client read deadline: %v", err)
	}
	read := make(chan readResult, 1)
	go func() {
		buffer := make([]byte, 1)
		count, err := client.Read(buffer)
		read <- readResult{count: count, err: err}
	}()

	select {
	case result := <-accepted:
		if result.connection != nil {
			result.connection.Close()
		}
		t.Fatalf("listener returned CID_LOCAL connection: %v", result.err)
	case result := <-read:
		if result.count != 0 || (!errors.Is(result.err, io.EOF) && !errors.Is(result.err, unix.ECONNRESET)) {
			t.Fatalf("CID_LOCAL client read = (%d, %v), want peer refusal", result.count, result.err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("listener did not refuse CID_LOCAL peer")
	}

	if err := listener.Close(); err != nil {
		t.Fatalf("close listener: %v", err)
	}
	select {
	case result := <-accepted:
		if result.connection != nil {
			result.connection.Close()
			t.Fatal("listener returned a connection after close")
		}
		if !errors.Is(result.err, net.ErrClosed) {
			t.Fatalf("accept error after close = %v, want net.ErrClosed", result.err)
		}
	case <-time.After(time.Second):
		t.Fatal("close did not unblock accept after refusing CID_LOCAL peer")
	}
}
