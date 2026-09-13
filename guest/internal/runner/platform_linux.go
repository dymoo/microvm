//go:build linux

package runner

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const (
	executionCgroupRoot = "/sys/fs/cgroup/microvm-exec"
	serviceCgroupRoot   = "/sys/fs/cgroup/microvm-service"
	webServiceCgroup    = "/sys/fs/cgroup/microvm-service/web"
	executionUID        = 1000
	executionGID        = 1000
)

type LinuxPlatform struct{}

func NewLinuxPlatform() (*LinuxPlatform, error) {
	if os.Geteuid() != 0 {
		return nil, errors.New("guest runner must start as root to isolate and drop command credentials")
	}
	if _, err := os.Stat("/sys/fs/cgroup/cgroup.controllers"); err != nil {
		return nil, fmt.Errorf("cgroup v2 unavailable: %w", err)
	}
	for _, root := range []string{executionCgroupRoot, serviceCgroupRoot} {
		if err := os.MkdirAll(root, 0o755); err != nil {
			return nil, fmt.Errorf("create guest workload cgroup root: %w", err)
		}
	}
	for _, controller := range []string{"cpu", "memory", "pids"} {
		if err := enableController("/sys/fs/cgroup", controller); err != nil {
			return nil, err
		}
		for _, root := range []string{executionCgroupRoot, serviceCgroupRoot} {
			if err := enableController(root, controller); err != nil {
				return nil, err
			}
		}
	}
	return &LinuxPlatform{}, nil
}

func enableController(parent, controller string) error {
	available, err := os.ReadFile(filepath.Join(parent, "cgroup.controllers"))
	if err != nil {
		return fmt.Errorf("read cgroup controllers: %w", err)
	}
	if !containsWord(string(available), controller) {
		return fmt.Errorf("required cgroup controller %q unavailable", controller)
	}
	if err := os.WriteFile(filepath.Join(parent, "cgroup.subtree_control"), []byte("+"+controller), 0o644); err != nil {
		return fmt.Errorf("enable cgroup controller %q: %w", controller, err)
	}
	return nil
}

func containsWord(value, wanted string) bool {
	for _, word := range strings.Fields(value) {
		if word == wanted || word == "+"+wanted {
			return true
		}
	}
	return false
}

func (p *LinuxPlatform) Prepare(command *exec.Cmd, requestID string) (ProcessScope, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return nil, fmt.Errorf("generate cgroup name: %w", err)
	}
	path := filepath.Join(executionCgroupRoot, hex.EncodeToString(random))
	return prepareLinuxScope(command, path)
}

func (p *LinuxPlatform) PrepareService(command *exec.Cmd) (ProcessScope, error) {
	return prepareLinuxScope(command, webServiceCgroup)
}

func prepareLinuxScope(command *exec.Cmd, path string) (ProcessScope, error) {
	if err := os.Mkdir(path, 0o755); err != nil {
		return nil, fmt.Errorf("create workload cgroup: %w", err)
	}
	scope := &linuxProcessScope{path: path, fd: -1}
	cleanupOnError := func(err error) (ProcessScope, error) {
		_ = os.Remove(path)
		return nil, err
	}
	for file, value := range map[string]string{
		"cpu.max":    "100000 100000",
		"memory.max": "536870912",
		"pids.max":   "128",
	} {
		if err := os.WriteFile(filepath.Join(path, file), []byte(value), 0o644); err != nil {
			return cleanupOnError(fmt.Errorf("configure workload cgroup %s: %w", file, err))
		}
	}
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return cleanupOnError(fmt.Errorf("open workload cgroup: %w", err))
	}
	scope.fd = fd
	command.SysProcAttr = &syscall.SysProcAttr{
		Setpgid:     true,
		Pdeathsig:   syscall.SIGKILL,
		Credential:  &syscall.Credential{Uid: executionUID, Gid: executionGID, Groups: []uint32{}},
		UseCgroupFD: true,
		CgroupFD:    fd,
	}
	return scope, nil
}

type linuxProcessScope struct {
	path string
	fd   int

	startOnce sync.Once
	killOnce  sync.Once
	killErr   error
}

func (s *linuxProcessScope) Started() {
	s.startOnce.Do(func() {
		if s.fd >= 0 {
			_ = unix.Close(s.fd)
			s.fd = -1
		}
	})
}

func (s *linuxProcessScope) Kill() error {
	s.killOnce.Do(func() {
		s.Started()
		if err := writeCgroupFile(s.path, "cgroup.freeze", "1"); err != nil && !errors.Is(err, os.ErrNotExist) {
			s.killErr = fmt.Errorf("freeze command cgroup: %w", err)
			return
		}
		if err := writeCgroupFile(s.path, "cgroup.kill", "1"); err != nil && !errors.Is(err, os.ErrNotExist) {
			_ = writeCgroupFile(s.path, "cgroup.freeze", "0")
			s.killErr = fmt.Errorf("kill command cgroup: %w", err)
			return
		}
		deadline := time.Now().Add(5 * time.Second)
		for {
			events, err := os.ReadFile(filepath.Join(s.path, "cgroup.events"))
			if errors.Is(err, os.ErrNotExist) || (err == nil && containsEvent(string(events), "populated", "0")) {
				break
			}
			if err != nil {
				s.killErr = fmt.Errorf("read command cgroup state: %w", err)
				break
			}
			if time.Now().After(deadline) {
				s.killErr = errors.New("command cgroup remained populated after kill")
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		if err := writeCgroupFile(s.path, "cgroup.freeze", "0"); err != nil && !errors.Is(err, os.ErrNotExist) && s.killErr == nil {
			s.killErr = fmt.Errorf("thaw command cgroup: %w", err)
		}
	})
	return s.killErr
}

func (s *linuxProcessScope) Close() error {
	s.Started()
	killErr := s.Kill()
	removeErr := os.Remove(s.path)
	if removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
		if killErr != nil {
			return fmt.Errorf("%v; remove command cgroup: %w", killErr, removeErr)
		}
		return fmt.Errorf("remove command cgroup: %w", removeErr)
	}
	return killErr
}

func writeCgroupFile(path, name, value string) error {
	return os.WriteFile(filepath.Join(path, name), []byte(value), 0o644)
}

func containsEvent(value, key, wanted string) bool {
	fields := strings.Fields(value)
	for index := 0; index+1 < len(fields); index += 2 {
		if fields[index] == key && fields[index+1] == wanted {
			return true
		}
	}
	return false
}
