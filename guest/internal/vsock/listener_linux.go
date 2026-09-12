//go:build linux

package vsock

import (
	"fmt"
	"net"
	"os"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

const Port uint32 = 1024

func Listen() (net.Listener, error) {
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("create AF_VSOCK socket: %w", err)
	}
	if err := unix.Bind(fd, &unix.SockaddrVM{CID: unix.VMADDR_CID_ANY, Port: Port}); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("bind AF_VSOCK port %d: %w", Port, err)
	}
	if err := unix.Listen(fd, 128); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("listen on AF_VSOCK port %d: %w", Port, err)
	}
	return &listener{fd: fd}, nil
}

type listener struct {
	fd        int
	closeOnce sync.Once
}

func (l *listener) Accept() (net.Conn, error) {
	fd, _, err := unix.Accept4(l.fd, unix.SOCK_CLOEXEC)
	if err != nil {
		return nil, os.NewSyscallError("accept4", err)
	}
	file := os.NewFile(uintptr(fd), "vsock-connection")
	if file == nil {
		unix.Close(fd)
		return nil, fmt.Errorf("wrap accepted AF_VSOCK connection")
	}
	return &connection{file: file}, nil
}

func (l *listener) Close() error {
	var err error
	l.closeOnce.Do(func() { err = unix.Close(l.fd) })
	return err
}

func (l *listener) Addr() net.Addr {
	return address{cid: unix.VMADDR_CID_ANY, port: Port}
}

type connection struct {
	file *os.File
}

func (c *connection) Read(buffer []byte) (int, error)  { return c.file.Read(buffer) }
func (c *connection) Write(buffer []byte) (int, error) { return c.file.Write(buffer) }
func (c *connection) Close() error                     { return c.file.Close() }
func (c *connection) LocalAddr() net.Addr              { return address{cid: unix.VMADDR_CID_ANY, port: Port} }
func (c *connection) RemoteAddr() net.Addr             { return address{} }
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
