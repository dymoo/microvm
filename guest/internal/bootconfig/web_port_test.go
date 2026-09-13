package bootconfig

import "testing"

func TestParseWebPort(t *testing.T) {
	port, configured, err := ParseWebPort("console=ttyS0 microvm.web_port=3000 reboot=k")
	if err != nil {
		t.Fatal(err)
	}
	if !configured || port != 3000 {
		t.Fatalf("web port = (%d, %t), want (3000, true)", port, configured)
	}
}

func TestParseWebPortAllowsMissingOptionalEndpoint(t *testing.T) {
	port, configured, err := ParseWebPort("console=ttyS0 reboot=k")
	if err != nil {
		t.Fatal(err)
	}
	if configured || port != 0 {
		t.Fatalf("web port = (%d, %t), want optional endpoint absent", port, configured)
	}
}

func TestParseWebPortRejectsInvalidOrDuplicateValues(t *testing.T) {
	for _, commandLine := range []string{
		"microvm.web_port",
		"microvm.web_port=1023",
		"microvm.web_port=65536",
		"microvm.web_port=not-a-port",
		"microvm.web_port=3000 microvm.web_port=3000",
	} {
		if _, _, err := ParseWebPort(commandLine); err == nil {
			t.Fatalf("ParseWebPort(%q) accepted invalid configuration", commandLine)
		}
	}
}
