package runner

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maximumServiceOutputBytes = 64 << 10

type ServiceProcessPlatform interface {
	PrepareService(command *exec.Cmd) (ProcessScope, error)
}

type ServiceController struct {
	platform      ServiceProcessPlatform
	workspaceRoot string

	mu      sync.Mutex
	current *webService
	closed  bool
}

func NewServiceController(platform ServiceProcessPlatform) *ServiceController {
	return &ServiceController{platform: platform, workspaceRoot: DefaultWorkingDirectory}
}

func (s *ServiceController) Serve(listener net.Listener) error {
	for {
		connection, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return fmt.Errorf("accept service control connection: %w", err)
		}
		go s.Handle(connection)
	}
}

func (s *ServiceController) Handle(connection io.ReadWriteCloser) {
	defer connection.Close()
	setReadDeadline(connection, time.Now().Add(5*time.Second))
	reader := bufio.NewReaderSize(connection, MaximumServiceRequestBytes+1)
	requestLine, err := readServiceRequestLine(reader)
	if err != nil {
		s.writeServiceError(connection, "", serviceRequestError(err.Error()))
		return
	}
	setReadDeadline(connection, time.Time{})

	var request ServiceRequest
	decoder := json.NewDecoder(bytes.NewReader(requestLine))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		s.writeServiceError(connection, request.ID, serviceRequestError("request must be one valid JSON object"))
		return
	}
	validated, err := validateServiceRequest(request)
	if err != nil {
		s.writeServiceError(connection, request.ID, err)
		return
	}

	var response any
	switch validated.Op {
	case ServiceOperationStart:
		response, err = s.start(validated)
	case ServiceOperationStatus:
		response = s.status(validated.ID)
	case ServiceOperationStop:
		response, err = s.stop(validated.ID)
	}
	if err != nil {
		s.writeServiceError(connection, validated.ID, err)
		return
	}
	setWriteDeadline(connection, time.Now().Add(2*time.Second))
	_ = json.NewEncoder(connection).Encode(response)
}

func readServiceRequestLine(reader *bufio.Reader) ([]byte, error) {
	var line bytes.Buffer
	for {
		fragment, err := reader.ReadSlice('\n')
		payloadLength := len(fragment)
		if err == nil {
			payloadLength--
		}
		if line.Len()+payloadLength > MaximumServiceRequestBytes {
			return nil, fmt.Errorf("request exceeds %d bytes", MaximumServiceRequestBytes)
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

func (s *ServiceController) start(request validatedServiceRequest) (ServiceStartedFrame, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ServiceStartedFrame{}, serviceStartError("service controller is shutting down")
	}
	if s.current != nil && !channelClosed(s.current.done) {
		return ServiceStartedFrame{}, serviceStartError("web service is already running")
	}

	command := exec.Command(request.Argv[0], request.Argv[1:]...)
	command.Dir = s.commandDirectory(request.Cwd)
	environment := make(map[string]string, len(request.Env)+2)
	for name, value := range request.Env {
		environment[name] = value
	}
	environment["HOSTNAME"] = "127.0.0.1"
	environment["PORT"] = strconv.Itoa(request.Port)
	command.Env = commandEnvironment(environment)

	stdout := newBoundedOutput(maximumServiceOutputBytes)
	stderr := newBoundedOutput(maximumServiceOutputBytes)
	command.Stdout = stdout
	command.Stderr = stderr
	command.Stdin = nil

	scope, err := s.platform.PrepareService(command)
	if err != nil {
		return ServiceStartedFrame{}, serviceInternalError("could not create isolated web service scope")
	}
	if err := command.Start(); err != nil {
		_ = scope.Close()
		return ServiceStartedFrame{}, serviceStartError(boundedMessage(err))
	}
	scope.Started()
	startedAt := time.Now()
	service := &webService{
		command:   command,
		scope:     scope,
		startedAt: startedAt,
		stdout:    stdout,
		stderr:    stderr,
		done:      make(chan struct{}),
	}
	s.current = service
	go service.wait()
	return ServiceStartedFrame{
		Version:          ProtocolVersion,
		ID:               request.ID,
		Type:             "started",
		StartedAtEpochMS: startedAt.UnixMilli(),
	}, nil
}

func (s *ServiceController) status(id string) ServiceStatusFrame {
	s.mu.Lock()
	service := s.current
	s.mu.Unlock()
	frame := ServiceStatusFrame{Version: ProtocolVersion, ID: id, Type: "status", State: "not_started"}
	if service == nil {
		return frame
	}
	startedAt := service.startedAt.UnixMilli()
	frame.StartedAtEpochMS = &startedAt
	exitCode, signal, done := service.result()
	if !done {
		frame.State = "running"
		return frame
	}
	frame.State = "exited"
	frame.ExitCode = &exitCode
	frame.Signal = signal
	return frame
}

func (s *ServiceController) stop(id string) (ServiceStoppedFrame, error) {
	s.mu.Lock()
	service := s.current
	s.mu.Unlock()
	frame := ServiceStoppedFrame{Version: ProtocolVersion, ID: id, Type: "stopped"}
	if service == nil || channelClosed(service.done) {
		return frame, nil
	}
	if err := service.stop(); err != nil {
		return ServiceStoppedFrame{}, serviceInternalError("could not stop web service")
	}
	frame.Stopped = true
	return frame, nil
}

func (s *ServiceController) Close() error {
	s.mu.Lock()
	if s.closed {
		service := s.current
		s.mu.Unlock()
		if service == nil || channelClosed(service.done) {
			return nil
		}
		return service.stop()
	}
	s.closed = true
	service := s.current
	s.mu.Unlock()
	if service == nil || channelClosed(service.done) {
		return nil
	}
	return service.stop()
}

func (s *ServiceController) commandDirectory(guestPath string) string {
	if s.workspaceRoot == DefaultWorkingDirectory {
		return guestPath
	}
	relative := strings.TrimPrefix(guestPath, DefaultWorkingDirectory)
	return s.workspaceRoot + relative
}

func (s *ServiceController) writeServiceError(writer io.Writer, id string, err error) {
	if !requestIDPattern.MatchString(id) {
		id = ""
	}
	code, message := serviceFrameError(err)
	setWriteDeadline(writer, time.Now().Add(2*time.Second))
	_ = json.NewEncoder(writer).Encode(ServiceErrorFrame{
		Version: ProtocolVersion,
		ID:      id,
		Type:    "error",
		Code:    code,
		Message: boundedMessage(errors.New(message)),
	})
}

type webService struct {
	command   *exec.Cmd
	scope     ProcessScope
	startedAt time.Time
	stdout    *boundedOutput
	stderr    *boundedOutput
	done      chan struct{}

	mu       sync.Mutex
	exitCode int
	signal   *string
	stopOnce sync.Once
	stopErr  error
}

func (s *webService) wait() {
	waitError := s.command.Wait()
	closeError := s.scope.Close()
	exitCode, signal := processResult(s.command.ProcessState, waitError)
	s.mu.Lock()
	s.exitCode = exitCode
	s.signal = signal
	if closeError != nil {
		s.stopErr = closeError
	}
	close(s.done)
	s.mu.Unlock()
}

func (s *webService) result() (int, *string, bool) {
	if !channelClosed(s.done) {
		return 0, nil, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.exitCode, s.signal, true
}

func (s *webService) stop() error {
	s.stopOnce.Do(func() {
		if err := s.scope.Kill(); err != nil {
			s.setStopError(err)
			return
		}
		select {
		case <-s.done:
		case <-time.After(2 * time.Second):
			s.setStopError(errors.New("web service did not exit after cgroup kill"))
		}
	})
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stopErr
}

func (s *webService) setStopError(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopErr == nil {
		s.stopErr = err
	}
}

func channelClosed(channel <-chan struct{}) bool {
	select {
	case <-channel:
		return true
	default:
		return false
	}
}

type boundedOutput struct {
	mu     sync.Mutex
	buffer []byte
	limit  int
}

func newBoundedOutput(limit int) *boundedOutput {
	return &boundedOutput{buffer: make([]byte, 0, limit), limit: limit}
}

func (b *boundedOutput) Write(value []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	originalLength := len(value)
	if len(value) >= b.limit {
		b.buffer = append(b.buffer[:0], value[len(value)-b.limit:]...)
		return originalLength, nil
	}
	overflow := len(b.buffer) + len(value) - b.limit
	if overflow > 0 {
		copy(b.buffer, b.buffer[overflow:])
		b.buffer = b.buffer[:len(b.buffer)-overflow]
	}
	b.buffer = append(b.buffer, value...)
	return originalLength, nil
}

func (b *boundedOutput) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.buffer)
}
