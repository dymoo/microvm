package runner

import (
	"errors"
	"path/filepath"
	"strings"
)

const MaximumServiceRequestBytes = 256 << 10

const (
	ServiceOperationStart  = "start"
	ServiceOperationStatus = "status"
	ServiceOperationStop   = "stop"
)

type ServiceRequest struct {
	Version int               `json:"version"`
	ID      string            `json:"id"`
	Op      string            `json:"op"`
	Argv    []string          `json:"argv,omitempty"`
	Cwd     string            `json:"cwd,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	Port    int               `json:"port,omitempty"`
}

type ServiceStartedFrame struct {
	Version          int    `json:"version"`
	ID               string `json:"id"`
	Type             string `json:"type"`
	StartedAtEpochMS int64  `json:"startedAtEpochMs"`
}

type ServiceStatusFrame struct {
	Version          int     `json:"version"`
	ID               string  `json:"id"`
	Type             string  `json:"type"`
	State            string  `json:"state"`
	StartedAtEpochMS *int64  `json:"startedAtEpochMs,omitempty"`
	ExitCode         *int    `json:"exitCode,omitempty"`
	Signal           *string `json:"signal,omitempty"`
}

type ServiceStoppedFrame struct {
	Version int    `json:"version"`
	ID      string `json:"id"`
	Type    string `json:"type"`
	Stopped bool   `json:"stopped"`
}

type ServiceErrorFrame struct {
	Version int    `json:"version"`
	ID      string `json:"id"`
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type validatedServiceRequest struct {
	ServiceRequest
}

func validateServiceRequest(request ServiceRequest) (validatedServiceRequest, error) {
	if request.Version != ProtocolVersion {
		return validatedServiceRequest{}, serviceRequestError("unsupported protocol version")
	}
	if !requestIDPattern.MatchString(request.ID) {
		return validatedServiceRequest{}, serviceRequestError("id must contain 1-128 safe characters")
	}
	switch request.Op {
	case ServiceOperationStart:
		if err := validateServiceStart(&request); err != nil {
			return validatedServiceRequest{}, err
		}
	case ServiceOperationStatus, ServiceOperationStop:
		if len(request.Argv) != 0 || request.Cwd != "" || len(request.Env) != 0 || request.Port != 0 {
			return validatedServiceRequest{}, serviceRequestError(request.Op + " does not accept start fields")
		}
	default:
		return validatedServiceRequest{}, serviceRequestError("op must be start, status, or stop")
	}
	return validatedServiceRequest{ServiceRequest: request}, nil
}

func validateServiceStart(request *ServiceRequest) error {
	if len(request.Argv) == 0 || len(request.Argv) > 128 {
		return serviceRequestError("argv must contain 1-128 entries")
	}
	argumentBytes := 0
	for _, argument := range request.Argv {
		if strings.IndexByte(argument, 0) >= 0 {
			return serviceRequestError("argv entries cannot contain NUL")
		}
		argumentBytes += len(argument)
	}
	if request.Argv[0] == "" || argumentBytes > 128<<10 {
		return serviceRequestError("argv is empty or too large")
	}

	cwd := request.Cwd
	if cwd == "" {
		cwd = DefaultWorkingDirectory
	}
	if !filepath.IsAbs(cwd) {
		return serviceRequestError("cwd must be an absolute guest path")
	}
	cwd = filepath.Clean(cwd)
	if cwd != DefaultWorkingDirectory && !strings.HasPrefix(cwd, DefaultWorkingDirectory+string(filepath.Separator)) {
		return serviceRequestError("cwd must be within /workspace")
	}
	request.Cwd = cwd

	if request.Port < 1024 || request.Port > 65535 {
		return serviceRequestError("port must be between 1024 and 65535")
	}
	if len(request.Env) > 128 {
		return serviceRequestError("env has too many entries")
	}
	environmentBytes := 0
	for name, value := range request.Env {
		if name == "HOSTNAME" || name == "PORT" {
			return serviceRequestError("env cannot set HOSTNAME or PORT")
		}
		if !environmentName.MatchString(name) || strings.IndexByte(value, 0) >= 0 {
			return serviceRequestError("env contains an invalid name or value")
		}
		environmentBytes += len(name) + len(value)
	}
	if environmentBytes > 128<<10 {
		return serviceRequestError("env is too large")
	}
	return nil
}

type serviceProtocolError struct {
	code    string
	message string
}

func (e serviceProtocolError) Error() string { return e.message }

func serviceRequestError(message string) error {
	return serviceProtocolError{code: "INVALID_REQUEST", message: message}
}

func serviceStartError(message string) error {
	return serviceProtocolError{code: "START_FAILED", message: message}
}

func serviceInternalError(message string) error {
	return serviceProtocolError{code: "INTERNAL", message: message}
}

func serviceFrameError(err error) (string, string) {
	var protocolError serviceProtocolError
	if errors.As(err, &protocolError) {
		return protocolError.code, protocolError.message
	}
	return "INTERNAL", "internal service control error"
}
