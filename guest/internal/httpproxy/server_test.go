package httpproxy

import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestProxyDialsOnlyConfiguredIPv4LoopbackAndSanitizesOneExchange(t *testing.T) {
	proxySide, hostSide := net.Pipe()
	originSide, dialSide := net.Pipe()
	defer hostSide.Close()
	defer originSide.Close()

	var dials atomic.Int32
	server := newServer(3456, func(_ context.Context, network, address string) (net.Conn, error) {
		dials.Add(1)
		if network != "tcp4" || address != "127.0.0.1:3456" {
			return nil, fmt.Errorf("unexpected dial %s %s", network, address)
		}
		return dialSide, nil
	})
	proxyDone := make(chan struct{})
	go func() {
		server.Handle(proxySide)
		close(proxyDone)
	}()

	originResult := make(chan error, 1)
	go func() {
		request, err := http.ReadRequest(bufio.NewReader(originSide))
		if err != nil {
			originResult <- err
			return
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			originResult <- err
			return
		}
		if request.Method != http.MethodPost || request.RequestURI != "/submit?raw=a%2Fb" || request.Host != "127.0.0.1:3456" || string(body) != "data" {
			originResult <- fmt.Errorf("unexpected request method=%s target=%s host=%s body=%q", request.Method, request.RequestURI, request.Host, body)
			return
		}
		for _, name := range []string{"X-Remove", "Proxy-Authorization", "X-Forwarded-For", "Microvm-Secret"} {
			if request.Header.Get(name) != "" {
				originResult <- fmt.Errorf("forwarded reserved header %s", name)
				return
			}
		}
		if request.Header.Get("Authorization") != "Bearer application" || !request.Close {
			originResult <- fmt.Errorf("application authorization or close semantics lost: %#v", request.Header)
			return
		}
		_, err = io.WriteString(originSide, "HTTP/1.1 201 Created\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
		originResult <- err
	}()

	_, err := io.WriteString(hostSide, "POST /submit?raw=a%2Fb HTTP/1.1\r\nHost: untrusted.example\r\nContent-Length: 4\r\nAuthorization: Bearer application\r\nProxy-Authorization: Bearer ingress\r\nX-Forwarded-For: 203.0.113.1\r\nMicrovm-Secret: value\r\nConnection: X-Remove\r\nX-Remove: value\r\n\r\ndataGET /ignored HTTP/1.1\r\nHost: ignored\r\n\r\n")
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(hostSide), &http.Request{Method: http.MethodPost})
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusCreated || string(body) != "ok" {
		t.Fatalf("response = %d %q", response.StatusCode, body)
	}
	if err := <-originResult; err != nil {
		t.Fatal(err)
	}
	select {
	case <-proxyDone:
	case <-time.After(time.Second):
		t.Fatal("proxy did not close after one exchange")
	}
	if dials.Load() != 1 {
		t.Fatalf("dial count = %d, want 1", dials.Load())
	}
}

func TestProxyClassifiesLoopbackRefusalAsUnavailable(t *testing.T) {
	proxySide, hostSide := net.Pipe()
	defer hostSide.Close()
	server := newServer(3000, func(context.Context, string, string) (net.Conn, error) {
		return nil, fmt.Errorf("connection refused")
	})
	go server.Handle(proxySide)

	if _, err := io.WriteString(hostSide, "GET / HTTP/1.1\r\nHost: fixed\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(hostSide), &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", response.StatusCode)
	}
}

func TestProxyFlushesStreamingResponseBeforeOriginCompletes(t *testing.T) {
	proxySide, hostSide := net.Pipe()
	originSide, dialSide := net.Pipe()
	defer hostSide.Close()
	defer originSide.Close()
	server := newServer(3000, func(context.Context, string, string) (net.Conn, error) { return dialSide, nil })
	go server.Handle(proxySide)

	releaseOrigin := make(chan struct{})
	originResult := make(chan error, 1)
	go func() {
		if _, err := http.ReadRequest(bufio.NewReader(originSide)); err != nil {
			originResult <- err
			return
		}
		if _, err := io.WriteString(originSide, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n9\r\ndata: x\n\n\r\n"); err != nil {
			originResult <- err
			return
		}
		<-releaseOrigin
		_, err := io.WriteString(originSide, "0\r\n\r\n")
		originResult <- err
	}()

	if _, err := io.WriteString(hostSide, "GET /events HTTP/1.1\r\nHost: fixed\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(hostSide), &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatal(err)
	}
	if err := hostSide.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	first := make([]byte, 9)
	if _, err := io.ReadFull(response.Body, first); err != nil {
		t.Fatalf("stream did not flush before completion: %v", err)
	}
	if string(first) != "data: x\n\n" {
		t.Fatalf("first event = %q", first)
	}
	close(releaseOrigin)
	_ = hostSide.SetReadDeadline(time.Time{})
	if _, err := io.ReadAll(response.Body); err != nil {
		t.Fatal(err)
	}
	if err := <-originResult; err != nil {
		t.Fatal(err)
	}
}

func TestProxyValidatesWebSocketHandshakeAndPreservesCoalescedTunnelBytes(t *testing.T) {
	proxySide, hostSide := net.Pipe()
	originSide, dialSide := net.Pipe()
	defer hostSide.Close()
	defer originSide.Close()
	server := newServer(3000, func(context.Context, string, string) (net.Conn, error) { return dialSide, nil })
	go server.Handle(proxySide)

	const key = "MDEyMzQ1Njc4OWFiY2RlZg=="
	digest := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	accept := base64.StdEncoding.EncodeToString(digest[:])
	originResult := make(chan error, 1)
	go func() {
		reader := bufio.NewReader(originSide)
		request, err := http.ReadRequest(reader)
		if err != nil {
			originResult <- err
			return
		}
		if request.Header.Get("Sec-WebSocket-Extensions") != "" || !strings.EqualFold(request.Header.Get("Upgrade"), "websocket") || request.Header.Get("Sec-WebSocket-Protocol") != "chat, superchat" {
			originResult <- fmt.Errorf("invalid forwarded websocket headers: %#v", request.Header)
			return
		}
		if _, err := fmt.Fprintf(originSide, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: %s\r\nSec-WebSocket-Protocol: superchat\r\n\r\norigin-first", accept); err != nil {
			originResult <- err
			return
		}
		clientBytes := make([]byte, len("client-first"))
		if _, err := io.ReadFull(reader, clientBytes); err != nil {
			originResult <- err
			return
		}
		if string(clientBytes) != "client-first" {
			originResult <- fmt.Errorf("client tunnel bytes = %q", clientBytes)
			return
		}
		originResult <- nil
	}()

	request := "GET /socket HTTP/1.1\r\nHost: fixed\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Protocol: chat, superchat\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\nclient-first"
	if _, err := io.WriteString(hostSide, request); err != nil {
		t.Fatal(err)
	}
	hostReader := bufio.NewReader(hostSide)
	header, err := readHeader(hostReader)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(header), "HTTP/1.1 101 ") || strings.Contains(strings.ToLower(string(header)), "sec-websocket-extensions") || !strings.Contains(strings.ToLower(string(header)), "sec-websocket-protocol: superchat\r\n") {
		t.Fatalf("unexpected upgrade response:\n%s", header)
	}
	originBytes := make([]byte, len("origin-first"))
	if _, err := io.ReadFull(hostReader, originBytes); err != nil {
		t.Fatal(err)
	}
	if string(originBytes) != "origin-first" {
		t.Fatalf("origin tunnel bytes = %q", originBytes)
	}
	if err := <-originResult; err != nil {
		t.Fatal(err)
	}
}

func TestProxyRejectsInvalidWebSocketSubprotocolOfferWithoutDialing(t *testing.T) {
	proxySide, hostSide := net.Pipe()
	defer hostSide.Close()
	var dials atomic.Int32
	server := newServer(3000, func(context.Context, string, string) (net.Conn, error) {
		dials.Add(1)
		return nil, fmt.Errorf("must not dial")
	})
	go server.Handle(proxySide)
	const request = "GET /socket HTTP/1.1\r\nHost: fixed\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\nSec-WebSocket-Protocol: chat, chat\r\n\r\n"
	if _, err := io.WriteString(hostSide, request); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(hostSide), &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	if response.StatusCode != http.StatusUpgradeRequired {
		t.Fatalf("status = %d, want 426", response.StatusCode)
	}
	if dials.Load() != 0 {
		t.Fatalf("dial count = %d, want 0", dials.Load())
	}
}

func TestProxyRejectsInvalidWebSocketSubprotocolSelection(t *testing.T) {
	for _, test := range []struct {
		name      string
		selection string
	}{
		{name: "unoffered", selection: "other"},
		{name: "multiple", selection: "chat, superchat"},
	} {
		t.Run(test.name, func(t *testing.T) {
			proxySide, hostSide := net.Pipe()
			originSide, dialSide := net.Pipe()
			defer hostSide.Close()
			defer originSide.Close()
			server := newServer(3000, func(context.Context, string, string) (net.Conn, error) { return dialSide, nil })
			go server.Handle(proxySide)

			const key = "MDEyMzQ1Njc4OWFiY2RlZg=="
			digest := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
			accept := base64.StdEncoding.EncodeToString(digest[:])
			originResult := make(chan error, 1)
			go func() {
				if _, err := http.ReadRequest(bufio.NewReader(originSide)); err != nil {
					originResult <- err
					return
				}
				_, err := fmt.Fprintf(originSide, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: %s\r\nSec-WebSocket-Protocol: %s\r\n\r\n", accept, test.selection)
				originResult <- err
			}()

			request := "GET /socket HTTP/1.1\r\nHost: fixed\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Protocol: chat, superchat\r\n\r\n"
			if _, err := io.WriteString(hostSide, request); err != nil {
				t.Fatal(err)
			}
			response, err := http.ReadResponse(bufio.NewReader(hostSide), &http.Request{Method: http.MethodGet})
			if err != nil {
				t.Fatal(err)
			}
			_, _ = io.Copy(io.Discard, response.Body)
			if response.StatusCode != http.StatusBadGateway {
				t.Fatalf("status = %d, want 502", response.StatusCode)
			}
			if err := <-originResult; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestProxyRejectsInvalidUpgradeWithoutDialing(t *testing.T) {
	proxySide, hostSide := net.Pipe()
	defer hostSide.Close()
	var dials atomic.Int32
	server := newServer(3000, func(context.Context, string, string) (net.Conn, error) {
		dials.Add(1)
		return nil, fmt.Errorf("must not dial")
	})
	go server.Handle(proxySide)
	if _, err := io.WriteString(hostSide, "GET /socket HTTP/1.1\r\nHost: fixed\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 12\r\nSec-WebSocket-Key: invalid\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(hostSide), &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	if response.StatusCode != http.StatusUpgradeRequired {
		t.Fatalf("status = %d, want 426", response.StatusCode)
	}
	if dials.Load() != 0 {
		t.Fatalf("dial count = %d, want 0", dials.Load())
	}
}

func TestProxyRejectsAmbiguousRequestFraming(t *testing.T) {
	proxySide, hostSide := net.Pipe()
	defer hostSide.Close()
	server := newServer(3000, func(context.Context, string, string) (net.Conn, error) {
		return nil, fmt.Errorf("must not dial")
	})
	go server.Handle(proxySide)
	if _, err := io.WriteString(hostSide, "POST / HTTP/1.1\r\nHost: fixed\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(hostSide), &http.Request{Method: http.MethodPost})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	if response.StatusCode != http.StatusBadRequest && response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want framing rejection", response.StatusCode)
	}
}
