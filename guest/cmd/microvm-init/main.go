//go:build linux

package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/dymoo/microvm/guest/internal/bootconfig"
)

const (
	agentPath     = "/usr/local/sbin/microvm-guest"
	httpProxyPath = "/usr/local/sbin/microvm-http-proxy"
	httpProxyUID  = 1001
	httpProxyGID  = 1001
)

func main() {
	log.SetFlags(0)
	if os.Getpid() != 1 {
		log.Fatal("microvm-init must run as PID 1")
	}
	if err := mountGuestFilesystems(); err != nil {
		log.Fatalf("guest init mount failure: %v", err)
	}
	if err := bringLoopbackUp(); err != nil {
		log.Fatalf("guest init loopback failure: %v", err)
	}
	if err := prepareWorkspace(); err != nil {
		log.Fatalf("guest init workspace failure: %v", err)
	}

	console, err := os.OpenFile("/dev/console", os.O_RDWR, 0)
	if err != nil {
		log.Fatalf("open console: %v", err)
	}
	defer console.Close()

	children := make(map[int]childProcess, 2)
	agent, err := startChild(console, agentPath, []string{agentPath}, nil)
	if err != nil {
		log.Fatalf("start guest runner: %v", err)
	}
	children[agent.Pid] = childProcess{name: "guest runner", process: agent}

	kernelCommandLine, err := os.ReadFile("/proc/cmdline")
	if err != nil {
		terminateChildren(children, nil)
		log.Fatalf("read kernel command line: %v", err)
	}
	webPort, webConfigured, err := bootconfig.ParseWebPort(string(kernelCommandLine))
	if err != nil {
		terminateChildren(children, nil)
		log.Fatalf("invalid guest web configuration: %v", err)
	}
	if webConfigured {
		proxy, err := startChild(
			console,
			httpProxyPath,
			[]string{httpProxyPath, "--port", strconv.Itoa(webPort)},
			&syscall.Credential{Uid: httpProxyUID, Gid: httpProxyGID, Groups: []uint32{}},
		)
		if err != nil {
			terminateChildren(children, nil)
			log.Fatalf("start guest HTTP proxy: %v", err)
		}
		children[proxy.Pid] = childProcess{name: "HTTP proxy", process: proxy}
	}

	waits := make(chan waitResult)
	go reapChildren(waits)
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)

	for {
		select {
		case received := <-signals:
			signalChildren(children, received.(syscall.Signal))
		case result := <-waits:
			if result.err != nil {
				log.Printf("guest init wait failure: %v", result.err)
				continue
			}
			child, supervised := children[result.pid]
			if !supervised {
				continue
			}
			delete(children, result.pid)
			log.Printf("%s exited with status %d; shutting down guest", child.name, result.status.ExitStatus())
			terminateChildren(children, waits)
			powerOff()
		}
	}
}

type childProcess struct {
	name    string
	process *os.Process
}

func startChild(console *os.File, path string, argv []string, credential *syscall.Credential) (*os.Process, error) {
	home := "/root"
	if credential != nil {
		home = "/"
	}
	return os.StartProcess(path, argv, &os.ProcAttr{
		Dir:   "/",
		Env:   []string{"HOME=" + home, "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
		Files: []*os.File{console, console, console},
		Sys: &syscall.SysProcAttr{
			Setpgid:    true,
			Credential: credential,
		},
	})
}

func signalChildren(children map[int]childProcess, signal syscall.Signal) {
	for _, child := range children {
		_ = syscall.Kill(-child.process.Pid, signal)
	}
}

func terminateChildren(children map[int]childProcess, waits <-chan waitResult) {
	if len(children) == 0 {
		return
	}
	signalChildren(children, syscall.SIGTERM)
	if waits == nil {
		signalChildren(children, syscall.SIGKILL)
		return
	}
	timer := time.NewTimer(8 * time.Second)
	defer timer.Stop()
	for len(children) != 0 {
		select {
		case result := <-waits:
			if result.err == nil {
				delete(children, result.pid)
			}
		case <-timer.C:
			signalChildren(children, syscall.SIGKILL)
			return
		}
	}
}

func powerOff() {
	unix.Sync()
	if err := unix.Reboot(unix.LINUX_REBOOT_CMD_POWER_OFF); err != nil {
		log.Printf("power off failed: %v", err)
		for {
			time.Sleep(time.Hour)
		}
	}
}

type waitResult struct {
	pid    int
	status syscall.WaitStatus
	err    error
}

func reapChildren(results chan<- waitResult) {
	for {
		var status syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &status, 0, nil)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if errors.Is(err, syscall.ECHILD) {
			time.Sleep(10 * time.Millisecond)
			continue
		}
		results <- waitResult{pid: pid, status: status, err: err}
	}
}

func mountGuestFilesystems() error {
	mounts := []struct {
		target string
		mode   os.FileMode
		source string
		fstype string
		flags  uintptr
		data   string
	}{
		{"/proc", 0o555, "proc", "proc", unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC, ""},
		{"/sys", 0o555, "sysfs", "sysfs", unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC, ""},
		{"/dev", 0o755, "devtmpfs", "devtmpfs", unix.MS_NOSUID, "mode=0755"},
		{"/dev/pts", 0o755, "devpts", "devpts", unix.MS_NOSUID | unix.MS_NOEXEC, "newinstance,ptmxmode=0666,mode=0620"},
		{"/run", 0o755, "tmpfs", "tmpfs", unix.MS_NOSUID | unix.MS_NODEV, "mode=0755,size=16m"},
		{"/tmp", 0o1777, "tmpfs", "tmpfs", unix.MS_NOSUID | unix.MS_NODEV, "mode=1777,size=64m"},
		{"/sys/fs/cgroup", 0o755, "cgroup2", "cgroup2", unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC, "nsdelegate"},
	}
	for _, mount := range mounts {
		if err := os.MkdirAll(mount.target, mount.mode); err != nil {
			return fmt.Errorf("create %s: %w", mount.target, err)
		}
		if err := unix.Mount(mount.source, mount.target, mount.fstype, mount.flags, mount.data); err != nil && !errors.Is(err, syscall.EBUSY) {
			return fmt.Errorf("mount %s: %w", mount.target, err)
		}
	}
	if err := os.MkdirAll("/sys/fs/cgroup/microvm-exec", 0o755); err != nil {
		return fmt.Errorf("create execution cgroup subtree: %w", err)
	}
	return nil
}

func bringLoopbackUp() error {
	socket, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("open control socket: %w", err)
	}
	defer unix.Close(socket)

	request, err := unix.NewIfreq("lo")
	if err != nil {
		return fmt.Errorf("create loopback request: %w", err)
	}
	if err := unix.IoctlIfreq(socket, unix.SIOCGIFFLAGS, request); err != nil {
		return fmt.Errorf("read loopback flags: %w", err)
	}
	flags := request.Uint16()
	if flags&unix.IFF_UP != 0 {
		return nil
	}
	request.SetUint16(flags | unix.IFF_UP)
	if err := unix.IoctlIfreq(socket, unix.SIOCSIFFLAGS, request); err != nil {
		return fmt.Errorf("raise loopback: %w", err)
	}
	return nil
}

func prepareWorkspace() error {
	if err := os.MkdirAll("/workspace", 0o700); err != nil {
		return err
	}
	if err := os.Chown("/workspace", 1000, 1000); err != nil {
		return err
	}
	return os.Chmod("/workspace", 0o700)
}
