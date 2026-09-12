//go:build linux

package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const agentPath = "/usr/local/sbin/microvm-guest"

func main() {
	log.SetFlags(0)
	if os.Getpid() != 1 {
		log.Fatal("microvm-init must run as PID 1")
	}
	if err := mountGuestFilesystems(); err != nil {
		log.Fatalf("guest init mount failure: %v", err)
	}
	if err := prepareWorkspace(); err != nil {
		log.Fatalf("guest init workspace failure: %v", err)
	}

	console, err := os.OpenFile("/dev/console", os.O_RDWR, 0)
	if err != nil {
		log.Fatalf("open console: %v", err)
	}
	defer console.Close()

	process, err := os.StartProcess(agentPath, []string{agentPath}, &os.ProcAttr{
		Dir:   "/",
		Env:   []string{"HOME=/root", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
		Files: []*os.File{console, console, console},
		Sys:   &syscall.SysProcAttr{Setpgid: true},
	})
	if err != nil {
		log.Fatalf("start guest runner: %v", err)
	}

	waits := make(chan waitResult)
	go reapChildren(waits)
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)

	for {
		select {
		case received := <-signals:
			_ = syscall.Kill(-process.Pid, received.(syscall.Signal))
		case result := <-waits:
			if result.err != nil {
				log.Printf("guest init wait failure: %v", result.err)
				continue
			}
			if result.pid == process.Pid {
				log.Printf("guest runner exited with status %d; powering off", result.status.ExitStatus())
				unix.Sync()
				if err := unix.Reboot(unix.LINUX_REBOOT_CMD_POWER_OFF); err != nil {
					log.Printf("power off failed: %v", err)
					for {
						time.Sleep(time.Hour)
					}
				}
			}
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

func prepareWorkspace() error {
	if err := os.MkdirAll("/workspace", 0o700); err != nil {
		return err
	}
	if err := os.Chown("/workspace", 1000, 1000); err != nil {
		return err
	}
	return os.Chmod("/workspace", 0o700)
}
