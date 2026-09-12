package runner

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	ProtocolVersion     = 1
	DefaultTimeout      = 30 * time.Second
	MaximumTimeout      = 10 * time.Minute
	DefaultOutputBytes  = 1 << 20
	MaximumOutputBytes  = 8 << 20
	MaximumRequestBytes = 8 << 20

	DefaultWorkingDirectory = "/workspace"
)

var (
	requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
	environmentName  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

type Request struct {
	Version        int               `json:"version"`
	ID             string            `json:"id"`
	Argv           []string          `json:"argv"`
	Cwd            string            `json:"cwd,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
	TimeoutMS      int64             `json:"timeoutMs,omitempty"`
	MaxOutputBytes int64             `json:"maxOutputBytes,omitempty"`
}

type DataFrame struct {
	Version int    `json:"version"`
	ID      string `json:"id"`
	Type    string `json:"type"`
	Seq     uint64 `json:"seq"`
	Data    string `json:"data"`
}

type ExitFrame struct {
	Version         int     `json:"version"`
	ID              string  `json:"id"`
	Type            string  `json:"type"`
	Code            int     `json:"code"`
	Signal          *string `json:"signal"`
	TimedOut        bool    `json:"timedOut"`
	OutputTruncated bool    `json:"outputTruncated"`
}

type ErrorFrame struct {
	Version int    `json:"version"`
	ID      string `json:"id"`
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type validatedRequest struct {
	Request
	timeout        time.Duration
	maxOutputBytes int64
}

func validateRequest(request Request) (validatedRequest, error) {
	if request.Version != ProtocolVersion {
		return validatedRequest{}, protocolError("unsupported protocol version")
	}
	if !requestIDPattern.MatchString(request.ID) {
		return validatedRequest{}, invalidRequestError("id must contain 1-128 safe characters")
	}
	if len(request.Argv) == 0 || len(request.Argv) > 128 {
		return validatedRequest{}, invalidRequestError("argv must contain 1-128 entries")
	}

	argumentBytes := 0
	for _, argument := range request.Argv {
		if strings.IndexByte(argument, 0) >= 0 {
			return validatedRequest{}, invalidRequestError("argv entries cannot contain NUL")
		}
		argumentBytes += len(argument)
	}
	if request.Argv[0] == "" || argumentBytes > 128<<10 {
		return validatedRequest{}, invalidRequestError("argv is empty or too large")
	}

	cwd := request.Cwd
	if cwd == "" {
		cwd = DefaultWorkingDirectory
	}
	if !filepath.IsAbs(cwd) {
		return validatedRequest{}, invalidRequestError("cwd must be an absolute guest path")
	}
	cwd = filepath.Clean(cwd)
	if cwd != DefaultWorkingDirectory && !strings.HasPrefix(cwd, DefaultWorkingDirectory+string(filepath.Separator)) {
		return validatedRequest{}, invalidRequestError("cwd must be within /workspace")
	}
	request.Cwd = cwd

	if len(request.Env) > 128 {
		return validatedRequest{}, invalidRequestError("env has too many entries")
	}
	environmentBytes := 0
	for name, value := range request.Env {
		if !environmentName.MatchString(name) || strings.IndexByte(value, 0) >= 0 {
			return validatedRequest{}, invalidRequestError("env contains an invalid name or value")
		}
		environmentBytes += len(name) + len(value)
	}
	if environmentBytes > 128<<10 {
		return validatedRequest{}, invalidRequestError("env is too large")
	}

	timeout := DefaultTimeout
	if request.TimeoutMS != 0 {
		if request.TimeoutMS < 1 || request.TimeoutMS > MaximumTimeout.Milliseconds() {
			return validatedRequest{}, invalidRequestError(fmt.Sprintf("timeoutMs must be between 1 and %d", MaximumTimeout.Milliseconds()))
		}
		timeout = time.Duration(request.TimeoutMS) * time.Millisecond
	}

	maxOutputBytes := int64(DefaultOutputBytes)
	if request.MaxOutputBytes != 0 {
		if request.MaxOutputBytes < 1 || request.MaxOutputBytes > MaximumOutputBytes {
			return validatedRequest{}, invalidRequestError(fmt.Sprintf("maxOutputBytes must be between 1 and %d", MaximumOutputBytes))
		}
		maxOutputBytes = request.MaxOutputBytes
	}

	return validatedRequest{Request: request, timeout: timeout, maxOutputBytes: maxOutputBytes}, nil
}

type requestError struct {
	code    string
	message string
}

func (e requestError) Error() string { return e.message }

func invalidRequestError(message string) error {
	return requestError{code: "INVALID_REQUEST", message: message}
}

func protocolError(message string) error {
	return requestError{code: "INVALID_REQUEST", message: message}
}

func frameError(err error) (string, string) {
	var typed requestError
	if errors.As(err, &typed) {
		return typed.code, typed.message
	}
	return "INTERNAL", "internal guest runner error"
}
