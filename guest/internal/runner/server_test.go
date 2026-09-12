package runner

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestRunnerPreservesOutputExitAndStreamSequences(t *testing.T) {
	frames := runRequest(t, Request{
		Version: ProtocolVersion,
		ID:      "output",
		Argv:    helperCommand("emit"),
	})

	var stdout, stderr string
	sequences := map[string]uint64{"stdout": 0, "stderr": 0}
	for _, frame := range frames[:len(frames)-1] {
		stream := stringField(t, frame, "type")
		if sequence := uint64(numberField(t, frame, "seq")); sequence != sequences[stream] {
			t.Fatalf("%s sequence = %d, want %d", stream, sequence, sequences[stream])
		}
		sequences[stream]++
		decoded, err := base64.StdEncoding.DecodeString(stringField(t, frame, "data"))
		if err != nil {
			t.Fatal(err)
		}
		if stream == "stdout" {
			stdout += string(decoded)
		} else {
			stderr += string(decoded)
		}
	}
	if stdout != "stdout-value" || stderr != "stderr-value" {
		t.Fatalf("stdout=%q stderr=%q", stdout, stderr)
	}
	terminal := frames[len(frames)-1]
	if stringField(t, terminal, "type") != "exit" || numberField(t, terminal, "code") != 7 {
		t.Fatalf("unexpected terminal frame: %#v", terminal)
	}
	if boolField(t, terminal, "timedOut") || boolField(t, terminal, "outputTruncated") {
		t.Fatalf("unexpected terminal flags: %#v", terminal)
	}
}

func TestRunnerTimesOutAndKillsProcess(t *testing.T) {
	started := time.Now()
	frames := runRequest(t, Request{
		Version:   ProtocolVersion,
		ID:        "timeout",
		Argv:      helperCommand("sleep"),
		TimeoutMS: 50,
	})
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("timeout took %v", elapsed)
	}
	terminal := frames[len(frames)-1]
	if numberField(t, terminal, "code") != 137 || !boolField(t, terminal, "timedOut") || stringField(t, terminal, "signal") != "SIGKILL" {
		t.Fatalf("unexpected timeout frame: %#v", terminal)
	}
}

func TestRunnerCapsEachOutputStream(t *testing.T) {
	frames := runRequest(t, Request{
		Version:        ProtocolVersion,
		ID:             "limit",
		Argv:           helperCommand("flood"),
		MaxOutputBytes: 1024,
	})
	var totals = map[string]int{"stdout": 0, "stderr": 0}
	for _, frame := range frames[:len(frames)-1] {
		data, err := base64.StdEncoding.DecodeString(stringField(t, frame, "data"))
		if err != nil {
			t.Fatal(err)
		}
		totals[stringField(t, frame, "type")] += len(data)
	}
	if totals["stdout"] > 1024 || totals["stderr"] > 1024 {
		t.Fatalf("output exceeded per-stream cap: %#v", totals)
	}
	if !boolField(t, frames[len(frames)-1], "outputTruncated") {
		t.Fatalf("missing truncation flag: %#v", frames[len(frames)-1])
	}
}

func TestRunnerKillsDescendantHoldingOutputPipes(t *testing.T) {
	started := time.Now()
	frames := runRequest(t, Request{
		Version: ProtocolVersion,
		ID:      "descendant",
		Argv:    helperCommand("descendant"),
	})
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("descendant retained output pipes for %v", elapsed)
	}
	terminal := frames[len(frames)-1]
	if numberField(t, terminal, "code") != 0 {
		t.Fatalf("leader result was not preserved: %#v", terminal)
	}
}

func TestRunnerRejectsInvalidRequestWithoutSpawning(t *testing.T) {
	frames := runRequest(t, Request{
		Version: ProtocolVersion,
		ID:      "invalid",
		Argv:    []string{"echo"},
		Cwd:     "/etc",
	})
	if len(frames) != 1 || stringField(t, frames[0], "type") != "error" || stringField(t, frames[0], "code") != "INVALID_REQUEST" {
		t.Fatalf("unexpected validation response: %#v", frames)
	}
}

func runRequest(t *testing.T, request Request) []map[string]any {
	t.Helper()
	serverSide, clientSide := net.Pipe()
	server := NewServer(testPlatform{})
	server.workspaceRoot = t.TempDir()
	done := make(chan struct{})
	go func() {
		server.Handle(serverSide)
		close(done)
	}()

	if err := json.NewEncoder(clientSide).Encode(request); err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bufio.NewReader(clientSide))
	var frames []map[string]any
	for {
		var frame map[string]any
		if err := decoder.Decode(&frame); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			t.Fatal(err)
		}
		frames = append(frames, frame)
		kind := stringField(t, frame, "type")
		if kind == "exit" || kind == "error" {
			break
		}
	}
	clientSide.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("runner did not close connection")
	}
	if len(frames) == 0 {
		t.Fatal("runner returned no frames")
	}
	return frames
}

type testPlatform struct{}

func (testPlatform) Prepare(command *exec.Cmd, _ string) (ProcessScope, error) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return &testScope{command: command}, nil
}

func TestRunnerClosesWithoutTerminalWhenIsolationCleanupFails(t *testing.T) {
	serverSide, clientSide := net.Pipe()
	server := NewServer(failingPlatform{})
	server.workspaceRoot = t.TempDir()
	done := make(chan struct{})
	go func() {
		server.Handle(serverSide)
		close(done)
	}()
	request := Request{
		Version:   ProtocolVersion,
		ID:        "cleanup-failure",
		Argv:      helperCommand("sleep"),
		TimeoutMS: 50,
	}
	if err := json.NewEncoder(clientSide).Encode(request); err != nil {
		t.Fatal(err)
	}
	clientSide.SetReadDeadline(time.Now().Add(time.Second))
	var frame map[string]any
	if err := json.NewDecoder(clientSide).Decode(&frame); !errors.Is(err, io.EOF) {
		t.Fatalf("cleanup failure returned a terminal frame: frame=%#v err=%v", frame, err)
	}
	clientSide.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("runner hung after isolation cleanup failure")
	}
}

type failingPlatform struct{}

func (failingPlatform) Prepare(command *exec.Cmd, _ string) (ProcessScope, error) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return &failingScope{command: command}, nil
}

type failingScope struct {
	command *exec.Cmd
	once    sync.Once
}

func (s *failingScope) Started() {}
func (s *failingScope) Kill() error {
	s.once.Do(func() {
		if s.command.Process != nil {
			_ = syscall.Kill(-s.command.Process.Pid, syscall.SIGKILL)
		}
	})
	return errors.New("injected cgroup kill failure")
}
func (s *failingScope) Close() error { return s.Kill() }

func TestRunnerTimeoutKillsWhileHostIsNotReading(t *testing.T) {
	serverSide, clientSide := net.Pipe()
	platform := &recordingPlatform{killed: make(chan struct{})}
	server := NewServer(platform)
	server.workspaceRoot = t.TempDir()
	done := make(chan struct{})
	go func() {
		server.Handle(serverSide)
		close(done)
	}()
	request := Request{
		Version:   ProtocolVersion,
		ID:        "backpressure",
		Argv:      helperCommand("flood"),
		TimeoutMS: 50,
	}
	if err := json.NewEncoder(clientSide).Encode(request); err != nil {
		t.Fatal(err)
	}
	select {
	case <-platform.killed:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timeout watchdog did not kill while response write was blocked")
	}
	clientSide.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("blocked response writer did not stop after disconnect")
	}
}

func TestReadOutputStopsWhenBackpressuredAndCanceled(t *testing.T) {
	readComplete := make(chan struct{})
	reader := &notifyingReader{readComplete: readComplete}
	events := make(chan outputEvent)
	canceled := make(chan struct{})
	done := make(chan struct{})
	go func() {
		readOutput("stdout", reader, events, canceled)
		close(done)
	}()

	select {
	case <-readComplete:
	case <-time.After(time.Second):
		t.Fatal("output reader did not read test data")
	}
	close(canceled)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("backpressured output reader did not stop after cancellation")
	}
}

type notifyingReader struct {
	readComplete chan struct{}
}

func (r *notifyingReader) Read(buffer []byte) (int, error) {
	count := copy(buffer, "blocked output")
	close(r.readComplete)
	return count, nil
}

type recordingPlatform struct {
	killed chan struct{}
	scope  *recordingScope
}

func (p *recordingPlatform) Prepare(command *exec.Cmd, _ string) (ProcessScope, error) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	p.scope = &recordingScope{command: command, killed: p.killed}
	return p.scope, nil
}

type recordingScope struct {
	command *exec.Cmd
	killed  chan struct{}
	once    sync.Once
}

func (s *recordingScope) Started() {}
func (s *recordingScope) Kill() error {
	s.once.Do(func() {
		if s.command.Process != nil {
			_ = syscall.Kill(-s.command.Process.Pid, syscall.SIGKILL)
		}
		close(s.killed)
	})
	return nil
}
func (s *recordingScope) Close() error { return s.Kill() }

type testScope struct {
	command *exec.Cmd
	once    sync.Once
}

func (s *testScope) Started() {}
func (s *testScope) Kill() error {
	s.once.Do(func() {
		if s.command.Process != nil {
			_ = syscall.Kill(-s.command.Process.Pid, syscall.SIGKILL)
		}
	})
	return nil
}
func (s *testScope) Close() error { return s.Kill() }

func helperCommand(mode string) []string {
	return []string{os.Args[0], "-test.run=TestRunnerHelperProcess", "--", mode}
}

func TestRunnerHelperProcess(t *testing.T) {
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
	case "emit":
		_, _ = io.WriteString(os.Stdout, "stdout-value")
		_, _ = io.WriteString(os.Stderr, "stderr-value")
		os.Exit(7)
	case "sleep":
		time.Sleep(10 * time.Second)
	case "flood":
		payload := strings.Repeat("x", 64<<10)
		_, _ = io.WriteString(os.Stdout, payload)
		_, _ = io.WriteString(os.Stderr, payload)
	case "descendant":
		child := exec.Command(os.Args[0], "-test.run=TestRunnerHelperProcess", "--", "sleep")
		child.Stdout = os.Stdout
		child.Stderr = os.Stderr
		if err := child.Start(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		return
	}
}

func stringField(t *testing.T, frame map[string]any, name string) string {
	t.Helper()
	if frame[name] == nil {
		return ""
	}
	value, ok := frame[name].(string)
	if !ok {
		t.Fatalf("%s is not a string in %#v", name, frame)
	}
	return value
}

func numberField(t *testing.T, frame map[string]any, name string) int {
	t.Helper()
	value, ok := frame[name].(float64)
	if !ok {
		t.Fatalf("%s is not a number in %#v", name, frame)
	}
	return int(value)
}

func boolField(t *testing.T, frame map[string]any, name string) bool {
	t.Helper()
	value, ok := frame[name].(bool)
	if !ok {
		t.Fatalf("%s is not a bool in %#v", name, frame)
	}
	return value
}
