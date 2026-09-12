package runner

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type ProcessScope interface {
	Started()
	Kill() error
	Close() error
}

type ProcessPlatform interface {
	Prepare(command *exec.Cmd, requestID string) (ProcessScope, error)
}

type Server struct {
	platform      ProcessPlatform
	workspaceRoot string
}

func NewServer(platform ProcessPlatform) *Server {
	return &Server{platform: platform, workspaceRoot: DefaultWorkingDirectory}
}
func (s *Server) Serve(listener net.Listener) error {
	for {
		connection, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return fmt.Errorf("accept guest connection: %w", err)
		}
		go s.Handle(connection)
	}
}

func (s *Server) Handle(connection io.ReadWriteCloser) {
	defer connection.Close()
	setReadDeadline(connection, time.Now().Add(5*time.Second))

	reader := bufio.NewReaderSize(connection, 64<<10)
	requestLine, err := readRequestLine(reader)
	if err != nil {
		s.writeError(connection, "", "INVALID_REQUEST", err.Error())
		return
	}
	setReadDeadline(connection, time.Time{})

	var request Request
	decoder := json.NewDecoder(bytes.NewReader(requestLine))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		s.writeError(connection, request.ID, "INVALID_REQUEST", "request must be one valid JSON object")
		return
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		s.writeError(connection, request.ID, "INVALID_REQUEST", "request must contain one JSON object")
		return
	}

	validated, err := validateRequest(request)
	if err != nil {
		code, message := frameError(err)
		s.writeError(connection, request.ID, code, message)
		return
	}

	s.execute(connection, reader, validated)
}

func readRequestLine(reader *bufio.Reader) ([]byte, error) {
	var line bytes.Buffer
	for {
		fragment, err := reader.ReadSlice('\n')
		payloadLength := len(fragment)
		if err == nil {
			payloadLength--
		}
		if line.Len()+payloadLength > MaximumRequestBytes {
			return nil, fmt.Errorf("request exceeds %d bytes", MaximumRequestBytes)
		}
		if err == nil {
			_, _ = line.Write(fragment[:len(fragment)-1])
			return line.Bytes(), nil
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			if errors.Is(err, io.EOF) {
				return nil, errors.New("request must end with a newline")
			}
			return nil, errors.New("could not read request")
		}
		_, _ = line.Write(fragment)
	}
}

type outputEvent struct {
	stream string
	data   []byte
	done   bool
}

func (s *Server) execute(connection io.ReadWriteCloser, requestReader *bufio.Reader, request validatedRequest) {
	command := exec.Command(request.Argv[0], request.Argv[1:]...)
	command.Dir = s.commandDirectory(request.Cwd)
	command.Env = commandEnvironment(request.Env)

	stdoutReader, stdoutWriter, err := os.Pipe()
	if err != nil {
		s.writeError(connection, request.ID, "INTERNAL", "could not create output pipes")
		return
	}
	stderrReader, stderrWriter, err := os.Pipe()
	if err != nil {
		stdoutReader.Close()
		stdoutWriter.Close()
		s.writeError(connection, request.ID, "INTERNAL", "could not create output pipes")
		return
	}
	outputCanceled := make(chan struct{})
	var outputReaders sync.WaitGroup
	defer func() {
		close(outputCanceled)
		_ = stdoutReader.Close()
		_ = stderrReader.Close()
		outputReaders.Wait()
	}()
	command.Stdout = stdoutWriter
	command.Stderr = stderrWriter
	command.Stdin = nil

	scope, err := s.platform.Prepare(command, request.ID)
	if err != nil {
		stdoutWriter.Close()
		stderrWriter.Close()
		s.writeError(connection, request.ID, "INTERNAL", "could not create isolated execution scope")
		return
	}
	scopeClosed := false
	defer func() {
		if !scopeClosed {
			_ = scope.Close()
		}
	}()

	if err := command.Start(); err != nil {
		stdoutWriter.Close()
		stderrWriter.Close()
		s.writeError(connection, request.ID, "EXEC_FAILED", boundedMessage(err))
		return
	}
	scope.Started()
	stdoutWriter.Close()
	stderrWriter.Close()

	events := make(chan outputEvent, 32)
	outputReaders.Add(2)
	go func() {
		defer outputReaders.Done()
		readOutput("stdout", stdoutReader, events, outputCanceled)
	}()
	go func() {
		defer outputReaders.Done()
		readOutput("stderr", stderrReader, events, outputCanceled)
	}()

	waited := make(chan error, 1)
	go func() { waited <- command.Wait() }()

	disconnected := make(chan struct{})
	go func() {
		_, _ = requestReader.ReadByte()
		close(disconnected)
	}()

	var deadlineExpired atomic.Bool
	timeoutResult := make(chan error, 1)
	watchdogStop := make(chan struct{})
	watchdogTimer := time.NewTimer(request.timeout)
	watchdogStopped := false
	go func() {
		select {
		case <-watchdogTimer.C:
			deadlineExpired.Store(true)
			timeoutResult <- scope.Kill()
		case <-watchdogStop:
		}
	}()
	stopWatchdog := func() {
		if watchdogStopped {
			return
		}
		watchdogStopped = true
		watchdogTimer.Stop()
		close(watchdogStop)
	}
	defer stopWatchdog()

	encoder := json.NewEncoder(connection)
	sequences := map[string]uint64{"stdout": 0, "stderr": 0}
	streamBytes := map[string]int64{"stdout": 0, "stderr": 0}
	streamsDone := 0
	var waitError error
	processDone := false
	timedOut := false
	truncated := false

	abortIsolation := func() {
		// No terminal frame: the daemon must poison and destroy this VM because
		// the runner cannot prove that the workload is gone.
		connection.Close()
	}
	kill := func() bool {
		if err := scope.Kill(); err != nil {
			abortIsolation()
			return false
		}
		return true
	}
	killAndWait := func() {
		stopWatchdog()
		if kill() && !processDone {
			waitForProcess(waited, 2*time.Second)
		}
	}

	for !processDone || streamsDone < 2 {
		select {
		case <-disconnected:
			killAndWait()
			return
		case err := <-timeoutResult:
			timedOut = true
			if err != nil {
				abortIsolation()
				return
			}
		case waitError = <-waited:
			processDone = true
			stopWatchdog()
			timedOut = deadlineExpired.Load()
			// A command is complete only when its full cgroup is gone. This also
			// closes output pipes retained by a double-forked descendant.
			if !kill() {
				return
			}
		case event := <-events:
			if event.done {
				streamsDone++
				continue
			}
			remaining := request.maxOutputBytes - streamBytes[event.stream]
			if remaining <= 0 {
				truncated = true
				stopWatchdog()
				if !kill() {
					return
				}
				continue
			}
			data := event.data
			if int64(len(data)) > remaining {
				data = data[:remaining]
				truncated = true
				stopWatchdog()
				if !kill() {
					return
				}
			}
			streamBytes[event.stream] += int64(len(data))
			frame := DataFrame{
				Version: ProtocolVersion,
				ID:      request.ID,
				Type:    event.stream,
				Seq:     sequences[event.stream],
				Data:    base64.StdEncoding.EncodeToString(data),
			}
			sequences[event.stream]++
			setWriteDeadline(connection, time.Now().Add(2*time.Second))
			if err := encoder.Encode(frame); err != nil {
				killAndWait()
				connection.Close()
				return
			}
		}
	}

	if err := scope.Close(); err != nil {
		abortIsolation()
		return
	}
	scopeClosed = true

	code, signal := processResult(command.ProcessState, waitError)
	if timedOut {
		code = 137
		value := "SIGKILL"
		signal = &value
	}
	setWriteDeadline(connection, time.Now().Add(2*time.Second))
	_ = encoder.Encode(ExitFrame{
		Version:         ProtocolVersion,
		ID:              request.ID,
		Type:            "exit",
		Code:            code,
		Signal:          signal,
		TimedOut:        timedOut,
		OutputTruncated: truncated,
	})
}

func readOutput(stream string, reader io.Reader, events chan<- outputEvent, canceled <-chan struct{}) {
	send := func(event outputEvent) bool {
		select {
		case events <- event:
			return true
		case <-canceled:
			return false
		}
	}

	buffer := make([]byte, 32<<10)
	for {
		count, err := reader.Read(buffer)
		if count > 0 {
			data := make([]byte, count)
			copy(data, buffer[:count])
			if !send(outputEvent{stream: stream, data: data}) {
				return
			}
		}
		if err != nil {
			_ = send(outputEvent{stream: stream, done: true})
			return
		}
	}
}

func (s *Server) commandDirectory(guestPath string) string {
	if s.workspaceRoot == DefaultWorkingDirectory {
		return guestPath
	}
	relative := strings.TrimPrefix(guestPath, DefaultWorkingDirectory)
	return s.workspaceRoot + relative
}
func waitForProcess(waited <-chan error, timeout time.Duration) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-waited:
	case <-timer.C:
	}
}

type readDeadlineSetter interface {
	SetReadDeadline(time.Time) error
}

type writeDeadlineSetter interface {
	SetWriteDeadline(time.Time) error
}

func setReadDeadline(connection any, deadline time.Time) {
	if setter, ok := connection.(readDeadlineSetter); ok {
		_ = setter.SetReadDeadline(deadline)
	}
}

func setWriteDeadline(connection any, deadline time.Time) {
	if setter, ok := connection.(writeDeadlineSetter); ok {
		_ = setter.SetWriteDeadline(deadline)
	}
}

func commandEnvironment(overrides map[string]string) []string {
	environment := map[string]string{
		"HOME": "/workspace",
		"LANG": "C.UTF-8",
		"PATH": "/usr/local/bin:/usr/bin:/bin",
		"USER": "agent",
	}
	for name, value := range overrides {
		environment[name] = value
	}

	names := make([]string, 0, len(environment))
	for name := range environment {
		names = append(names, name)
	}
	sort.Strings(names)
	result := make([]string, 0, len(names))
	for _, name := range names {
		result = append(result, name+"="+environment[name])
	}
	return result
}

func processResult(state *os.ProcessState, waitError error) (int, *string) {
	if state == nil {
		return 1, nil
	}
	status, ok := state.Sys().(syscall.WaitStatus)
	if ok && status.Signaled() {
		name := signalName(status.Signal())
		return 128 + int(status.Signal()), &name
	}
	if waitError != nil {
		return state.ExitCode(), nil
	}
	return state.ExitCode(), nil
}

func signalName(signal syscall.Signal) string {
	switch signal {
	case syscall.SIGHUP:
		return "SIGHUP"
	case syscall.SIGINT:
		return "SIGINT"
	case syscall.SIGQUIT:
		return "SIGQUIT"
	case syscall.SIGILL:
		return "SIGILL"
	case syscall.SIGTRAP:
		return "SIGTRAP"
	case syscall.SIGABRT:
		return "SIGABRT"
	case syscall.SIGFPE:
		return "SIGFPE"
	case syscall.SIGKILL:
		return "SIGKILL"
	case syscall.SIGBUS:
		return "SIGBUS"
	case syscall.SIGSEGV:
		return "SIGSEGV"
	case syscall.SIGPIPE:
		return "SIGPIPE"
	case syscall.SIGALRM:
		return "SIGALRM"
	case syscall.SIGTERM:
		return "SIGTERM"
	default:
		return fmt.Sprintf("SIG%d", signal)
	}
}

func boundedMessage(err error) string {
	message := err.Error()
	if len(message) > 512 {
		message = message[:512]
	}
	return message
}

func (s *Server) writeError(writer io.Writer, id, code, message string) {
	if !requestIDPattern.MatchString(id) {
		id = ""
	}
	message = boundedMessage(errors.New(message))
	setWriteDeadline(writer, time.Now().Add(2*time.Second))
	_ = json.NewEncoder(writer).Encode(ErrorFrame{
		Version: ProtocolVersion,
		ID:      id,
		Type:    "error",
		Code:    code,
		Message: message,
	})
}
