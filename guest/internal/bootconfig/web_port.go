package bootconfig

import (
	"fmt"
	"strconv"
	"strings"
)

const webPortKey = "microvm.web_port"

func ParseWebPort(kernelCommandLine string) (int, bool, error) {
	port := 0
	configured := false
	for _, field := range strings.Fields(kernelCommandLine) {
		if field != webPortKey && !strings.HasPrefix(field, webPortKey+"=") {
			continue
		}
		if configured {
			return 0, false, fmt.Errorf("%s is configured more than once", webPortKey)
		}
		configured = true
		value, present := strings.CutPrefix(field, webPortKey+"=")
		if !present || value == "" {
			return 0, false, fmt.Errorf("%s requires a port", webPortKey)
		}
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1024 || parsed > 65535 {
			return 0, false, fmt.Errorf("%s must be an integer between 1024 and 65535", webPortKey)
		}
		port = parsed
	}
	return port, configured, nil
}
