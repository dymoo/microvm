package runner

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestServiceControlLineLimit(t *testing.T) {
	exact := strings.Repeat("x", MaximumServiceRequestBytes) + "\n"
	line, err := readServiceRequestLine(bufio.NewReaderSize(strings.NewReader(exact), 4096))
	if err != nil {
		t.Fatalf("maximum service line failed: %v", err)
	}
	if len(line) != MaximumServiceRequestBytes {
		t.Fatalf("maximum service line length = %d, want %d", len(line), MaximumServiceRequestBytes)
	}

	over := strings.Repeat("x", MaximumServiceRequestBytes+1) + "\n"
	if _, err := readServiceRequestLine(bufio.NewReaderSize(strings.NewReader(over), 4096)); err == nil {
		t.Fatal("service line over maximum was accepted")
	}
}

func TestWebServiceOutlivesControlConnectionAndReceivesTrustedBinding(t *testing.T) {
	platform := &serviceTestPlatform{}
	controller := NewServiceController(platform)
	controller.workspaceRoot = t.TempDir()
	defer controller.Close()
	capture := filepath.Join(t.TempDir(), "environment")

	started := sendServiceRequest(t, controller, ServiceRequest{
		Version: ProtocolVersion,
		ID:      "start",
		Op:      ServiceOperationStart,
		Argv:    serviceHelperCommand("serve"),
		Env:     map[string]string{"CAPTURE": capture, "APPLICATION_VALUE": "preserved"},
		Port:    4321,
	})
	if stringField(t, started, "type") != "started" || numberField(t, started, "startedAtEpochMs") <= 0 {
		t.Fatalf("unexpected start response: %#v", started)
	}
	waitForFile(t, capture)
	contents, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "127.0.0.1\n4321\npreserved" {
		t.Fatalf("service environment = %q", contents)
	}

	status := sendServiceRequest(t, controller, ServiceRequest{Version: ProtocolVersion, ID: "status", Op: ServiceOperationStatus})
	if stringField(t, status, "state") != "running" {
		t.Fatalf("service did not survive start connection close: %#v", status)
	}
	stopped := sendServiceRequest(t, controller, ServiceRequest{Version: ProtocolVersion, ID: "stop", Op: ServiceOperationStop})
	if !boolField(t, stopped, "stopped") {
		t.Fatalf("service was not stopped: %#v", stopped)
	}
	status = sendServiceRequest(t, controller, ServiceRequest{Version: ProtocolVersion, ID: "stopped-status", Op: ServiceOperationStatus})
	if stringField(t, status, "state") != "exited" || stringField(t, status, "signal") != "SIGKILL" {
		t.Fatalf("stopped service status = %#v", status)
	}
	again := sendServiceRequest(t, controller, ServiceRequest{Version: ProtocolVersion, ID: "stop-again", Op: ServiceOperationStop})
	if boolField(t, again, "stopped") {
		t.Fatalf("second stop claimed to stop the exited process: %#v", again)
	}
}

func TestWebServiceRejectsReservedEnvironmentAndSecondRunningService(t *testing.T) {
	platform := &serviceTestPlatform{}
	controller := NewServiceController(platform)
	controller.workspaceRoot = t.TempDir()
	defer controller.Close()

	for _, reserved := range []string{"HOSTNAME", "PORT"} {
		response := sendServiceRequest(t, controller, ServiceRequest{
			Version: ProtocolVersion,
			ID:      "reserved-" + strings.ToLower(reserved),
			Op:      ServiceOperationStart,
			Argv:    serviceHelperCommand("serve"),
			Env:     map[string]string{reserved: "untrusted"},
			Port:    3000,
		})
		if stringField(t, response, "type") != "error" || stringField(t, response, "code") != "INVALID_REQUEST" {
			t.Fatalf("reserved %s response = %#v", reserved, response)
		}
	}
	if platform.startCount() != 0 {
		t.Fatalf("invalid request prepared %d processes", platform.startCount())
	}

	started := sendServiceRequest(t, controller, ServiceRequest{
		Version: ProtocolVersion,
		ID:      "first",
		Op:      ServiceOperationStart,
		Argv:    serviceHelperCommand("serve"),
		Port:    3000,
	})
	if stringField(t, started, "type") != "started" {
		t.Fatalf("first start = %#v", started)
	}
	second := sendServiceRequest(t, controller, ServiceRequest{
		Version: ProtocolVersion,
		ID:      "second",
		Op:      ServiceOperationStart,
		Argv:    serviceHelperCommand("serve"),
		Port:    3000,
	})
	if stringField(t, second, "type") != "error" || stringField(t, second, "code") != "START_FAILED" {
		t.Fatalf("second start = %#v", second)
	}
	if platform.startCount() != 1 {
		t.Fatalf("prepared %d processes, want exactly one", platform.startCount())
	}
}

func TestWebServiceDrainsBoundedOutputAndNormalExitAllowsRestart(t *testing.T) {
	platform := &serviceTestPlatform{}
	controller := NewServiceController(platform)
	controller.workspaceRoot = t.TempDir()
	defer controller.Close()

	response := sendServiceRequest(t, controller, ServiceRequest{
		Version: ProtocolVersion,
		ID:      "flood",
		Op:      ServiceOperationStart,
		Argv:    serviceHelperCommand("flood"),
		Port:    3000,
	})
	if stringField(t, response, "type") != "started" {
		t.Fatalf("flood start = %#v", response)
	}
	status := waitForServiceState(t, controller, "exited")
	if numberField(t, status, "exitCode") != 0 || status["signal"] != nil {
		t.Fatalf("normal output-heavy exit = %#v", status)
	}
	controller.mu.Lock()
	stdoutLength := controller.current.stdout.Len()
	stderrLength := controller.current.stderr.Len()
	controller.mu.Unlock()
	if stdoutLength != maximumServiceOutputBytes || stderrLength != maximumServiceOutputBytes {
		t.Fatalf("bounded output lengths = (%d, %d), want (%d, %d)", stdoutLength, stderrLength, maximumServiceOutputBytes, maximumServiceOutputBytes)
	}

	restarted := sendServiceRequest(t, controller, ServiceRequest{
		Version: ProtocolVersion,
		ID:      "restart",
		Op:      ServiceOperationStart,
		Argv:    serviceHelperCommand("exit-seven"),
		Port:    3000,
	})
	if stringField(t, restarted, "type") != "started" {
		t.Fatalf("restart after normal exit = %#v", restarted)
	}
	status = waitForServiceState(t, controller, "exited")
	if numberField(t, status, "exitCode") != 7 || status["signal"] != nil {
		t.Fatalf("restarted service exit = %#v", status)
	}
}

func TestExecRemainsAvailableWhileWebServiceRuns(t *testing.T) {
	platform := &serviceTestPlatform{}
	workspace := t.TempDir()
	controller := NewServiceController(platform)
	controller.workspaceRoot = workspace
	defer controller.Close()
	started := sendServiceRequest(t, controller, ServiceRequest{
		Version: ProtocolVersion,
		ID:      "web",
		Op:      ServiceOperationStart,
		Argv:    serviceHelperCommand("serve"),
		Port:    3000,
	})
	if stringField(t, started, "type") != "started" {
		t.Fatalf("start = %#v", started)
	}

	serverSide, clientSide := net.Pipe()
	execServer := NewServer(platform)
	execServer.workspaceRoot = workspace
	done := make(chan struct{})
	go func() {
		execServer.Handle(serverSide)
		close(done)
	}()
	if err := json.NewEncoder(clientSide).Encode(Request{Version: ProtocolVersion, ID: "concurrent", Argv: serviceHelperCommand("exit-seven")}); err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bufio.NewReader(clientSide))
	var terminal map[string]any
	for {
		if err := decoder.Decode(&terminal); err != nil {
			t.Fatal(err)
		}
		if stringField(t, terminal, "type") == "exit" {
			break
		}
	}
	clientSide.Close()
	<-done
	if numberField(t, terminal, "code") != 7 {
		t.Fatalf("concurrent exec terminal = %#v", terminal)
	}
	status := sendServiceRequest(t, controller, ServiceRequest{Version: ProtocolVersion, ID: "still-running", Op: ServiceOperationStatus})
	if stringField(t, status, "state") != "running" {
		t.Fatalf("exec disturbed web service: %#v", status)
	}
}

func sendServiceRequest(t *testing.T, controller *ServiceController, request ServiceRequest) map[string]any {
	t.Helper()
	serverSide, clientSide := net.Pipe()
	done := make(chan struct{})
	go func() {
		controller.Handle(serverSide)
		close(done)
	}()
	if err := json.NewEncoder(clientSide).Encode(request); err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err := json.NewDecoder(clientSide).Decode(&response); err != nil {
		t.Fatal(err)
	}
	clientSide.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("service control connection did not close after one response")
	}
	return response
}

func waitForServiceState(t *testing.T, controller *ServiceController, state string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		response := sendServiceRequest(t, controller, ServiceRequest{Version: ProtocolVersion, ID: "poll", Op: ServiceOperationStatus})
		if stringField(t, response, "state") == state {
			return response
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("service did not reach state %s", state)
	return nil
}

func waitForFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("service did not write %s", path)
}

type serviceTestPlatform struct {
	mu     sync.Mutex
	starts int
}

func (p *serviceTestPlatform) Prepare(command *exec.Cmd, _ string) (ProcessScope, error) {
	return p.prepare(command), nil
}

func (p *serviceTestPlatform) PrepareService(command *exec.Cmd) (ProcessScope, error) {
	return p.prepare(command), nil
}

func (p *serviceTestPlatform) prepare(command *exec.Cmd) ProcessScope {
	p.mu.Lock()
	p.starts++
	p.mu.Unlock()
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return &serviceTestScope{command: command}
}

func (p *serviceTestPlatform) startCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.starts
}

type serviceTestScope struct {
	command *exec.Cmd
	once    sync.Once
}

func (s *serviceTestScope) Started() {}

func (s *serviceTestScope) Kill() error {
	s.once.Do(func() {
		if s.command.Process != nil {
			err := syscall.Kill(-s.command.Process.Pid, syscall.SIGKILL)
			if err != nil && !errors.Is(err, syscall.ESRCH) {
				return
			}
		}
	})
	return nil
}

func (s *serviceTestScope) Close() error { return s.Kill() }

func serviceHelperCommand(mode string) []string {
	return []string{os.Args[0], "-test.run=TestServiceHelperProcess", "--", mode}
}

func TestServiceHelperProcess(t *testing.T) {
	separator := -1
	for index, argument := range os.Args {
		if argument == "--" {
			separator = index
			break
		}
	}
	if separator < 0 || separator+1 >= len(os.Args) {
		return
	}
	switch os.Args[separator+1] {
	case "serve":
		if capture := os.Getenv("CAPTURE"); capture != "" {
			value := fmt.Sprintf("%s\n%s\n%s", os.Getenv("HOSTNAME"), os.Getenv("PORT"), os.Getenv("APPLICATION_VALUE"))
			if err := os.WriteFile(capture, []byte(value), 0o600); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(2)
			}
		}
		time.Sleep(10 * time.Second)
	case "flood":
		payload := strings.Repeat("x", 1<<20)
		_, _ = io.WriteString(os.Stdout, payload)
		_, _ = io.WriteString(os.Stderr, payload)
	case "exit-seven":
		os.Exit(7)
	}
}
