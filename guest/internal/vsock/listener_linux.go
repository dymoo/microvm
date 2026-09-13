//go:build linux

package vsock

import (
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sys/unix"
)

const (
	ExecPort    uint32 = 1024
	HTTPPort    uint32 = 1025
	ServicePort uint32 = 1026
)

func ListenExec() (net.Listener, error)    { return listen(ExecPort) }
func ListenHTTP() (net.Listener, error)    { return listen(HTTPPort) }
func ListenService() (net.Listener, error) { return listen(ServicePort) }

func listen(port uint32) (net.Listener, error) {
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC|unix.SOCK_NONBLOCK, 0)
	if err != nil {
		return nil, fmt.Errorf("create AF_VSOCK socket: %w", err)
	}
	if err := unix.Bind(fd, &unix.SockaddrVM{CID: unix.VMADDR_CID_ANY, Port: port}); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("bind AF_VSOCK port %d: %w", port, err)
	}
	if err := unix.Listen(fd, 128); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("listen on AF_VSOCK port %d: %w", port, err)
	}
	file := os.NewFile(uintptr(fd), "vsock-listener")
	if file == nil {
		unix.Close(fd)
		return nil, fmt.Errorf("wrap AF_VSOCK listener")
	}
	return &listener{file: file, port: port}, nil
}

type listener struct {
	file      *os.File
	closeOnce sync.Once
	closed    atomic.Bool
	port      uint32
}

func (l *listener) Accept() (net.Conn, error) {
	raw, err := l.file.SyscallConn()
	if err != nil {
		return nil, l.acceptError(err)
	}

	for {
		var (
			fd        int
			peer      unix.Sockaddr
			acceptErr error
		)
		err := raw.Read(func(listenerFD uintptr) bool {
			for {
				fd, peer, acceptErr = unix.Accept4(
					int(listenerFD),
					unix.SOCK_CLOEXEC|unix.SOCK_NONBLOCK,
				)
				if errors.Is(acceptErr, unix.EINTR) {
					continue
				}
				return !errors.Is(acceptErr, unix.EAGAIN) &&
					!errors.Is(acceptErr, unix.EWOULDBLOCK)
			}
		})
		if err != nil {
			return nil, l.acceptError(err)
		}
		if acceptErr != nil {
			return nil, os.NewSyscallError("accept4", acceptErr)
		}

		vmPeer, trusted := peer.(*unix.SockaddrVM)
		if !trusted || vmPeer.CID != unix.VMADDR_CID_HOST {
			unix.Close(fd)
			continue
		}

		local, err := unix.Getsockname(fd)
		if err != nil {
			unix.Close(fd)
			return nil, os.NewSyscallError("getsockname", err)
		}
		vmLocal, ok := local.(*unix.SockaddrVM)
		if !ok {
			unix.Close(fd)
			return nil, fmt.Errorf("accepted AF_VSOCK local address has type %T", local)
		}

		file := os.NewFile(uintptr(fd), "vsock-connection")
		if file == nil {
			unix.Close(fd)
			return nil, fmt.Errorf("wrap accepted AF_VSOCK connection")
		}
		return &connection{
			file:   file,
			local:  address{cid: vmLocal.CID, port: vmLocal.Port},
			remote: address{cid: vmPeer.CID, port: vmPeer.Port},
		}, nil
	}
}

func (l *listener) acceptError(err error) error {
	if l.closed.Load() || errors.Is(err, net.ErrClosed) || errors.Is(err, os.ErrClosed) {
		return net.ErrClosed
	}
	return os.NewSyscallError("accept4", err)
}

func (l *listener) Close() error {
	var err error
	l.closeOnce.Do(func() {
		l.closed.Store(true)
		err = l.file.Close()
	})
	return err
}

func (l *listener) Addr() net.Addr {
	return address{cid: unix.VMADDR_CID_ANY, port: l.port}
}

type connection struct {
	file   *os.File
	local  address
	remote address
}

func (c *connection) Read(buffer []byte) (int, error)  { return c.file.Read(buffer) }
func (c *connection) Write(buffer []byte) (int, error) { return c.file.Write(buffer) }
func (c *connection) Close() error                     { return c.file.Close() }
func (c *connection) LocalAddr() net.Addr              { return c.local }
func (c *connection) RemoteAddr() net.Addr             { return c.remote }
func (c *connection) SetDeadline(value time.Time) error {
	return c.file.SetDeadline(value)
}
func (c *connection) SetReadDeadline(value time.Time) error {
	return c.file.SetReadDeadline(value)
}
func (c *connection) SetWriteDeadline(value time.Time) error {
	return c.file.SetWriteDeadline(value)
}

type address struct {
	cid  uint32
	port uint32
}

func (a address) Network() string { return "vsock" }
func (a address) String() string  { return fmt.Sprintf("%d:%d", a.cid, a.port) }
