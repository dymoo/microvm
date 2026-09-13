package httpproxy

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	MinimumWebPort          = 1024
	MaximumWebPort          = 65535
	MaximumHeaderBytes      = 16 << 10
	MaximumHeaderFields     = 64
	MaximumRequestTarget    = 8 << 10
	MaximumRequestBodyBytes = 16 << 20
	HeaderTimeout           = 5 * time.Second
	UploadIdleTimeout       = 30 * time.Second
	ResponseHeaderTimeout   = 120 * time.Second
)

var errRequestBodyTooLarge = errors.New("request body is too large")

type DialContextFunc func(context.Context, string, string) (net.Conn, error)

type Server struct {
	port int
	dial DialContextFunc
}

func New(port int) (*Server, error) {
	if port < MinimumWebPort || port > MaximumWebPort {
		return nil, fmt.Errorf("web port must be between %d and %d", MinimumWebPort, MaximumWebPort)
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: -1}
	return &Server{port: port, dial: dialer.DialContext}, nil
}

func newServer(port int, dial DialContextFunc) *Server {
	return &Server{port: port, dial: dial}
}

func (s *Server) Serve(listener net.Listener) error {
	for {
		connection, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return fmt.Errorf("accept HTTP proxy connection: %w", err)
		}
		go s.Handle(connection)
	}
}

func (s *Server) Handle(connection net.Conn) {
	defer connection.Close()
	_ = connection.SetReadDeadline(time.Now().Add(HeaderTimeout))
	outerReader := bufio.NewReaderSize(connection, MaximumHeaderBytes+1)
	header, err := readHeader(outerReader)
	if err != nil {
		writeErrorResponse(connection, http.StatusBadRequest)
		return
	}

	requestReader := bufio.NewReaderSize(io.MultiReader(bytes.NewReader(header), outerReader), MaximumHeaderBytes+1)
	request, err := http.ReadRequest(requestReader)
	if err != nil {
		writeErrorResponse(connection, http.StatusBadRequest)
		return
	}
	defer request.Body.Close()
	_ = connection.SetReadDeadline(time.Time{})

	websocket, status := validateRequest(request, header)
	if status != 0 {
		writeErrorResponse(connection, status)
		return
	}

	address := net.JoinHostPort("127.0.0.1", strconv.Itoa(s.port))
	upstream, err := s.dial(request.Context(), "tcp4", address)
	if err != nil {
		writeDialError(connection, err)
		return
	}
	defer upstream.Close()

	prepareRequest(request, address, websocket)
	request.Body = &boundedRequestBody{body: request.Body, connection: connection, remaining: MaximumRequestBodyBytes}
	if err := request.Write(upstream); err != nil {
		if errors.Is(err, errRequestBodyTooLarge) {
			writeErrorResponse(connection, http.StatusRequestEntityTooLarge)
		}
		return
	}
	_ = connection.SetReadDeadline(time.Time{})
	if !websocket {
		go closeUpstreamOnOuterDisconnect(requestReader, upstream)
	}

	_ = upstream.SetReadDeadline(time.Now().Add(ResponseHeaderTimeout))
	upstreamReader := bufio.NewReaderSize(upstream, MaximumHeaderBytes+1)
	responseHeader, err := readHeader(upstreamReader)
	if err != nil {
		writeUpstreamError(connection, err)
		return
	}
	responseReader := bufio.NewReaderSize(io.MultiReader(bytes.NewReader(responseHeader), upstreamReader), MaximumHeaderBytes+1)
	response, err := http.ReadResponse(responseReader, request)
	if err != nil {
		writeErrorResponse(connection, http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	_ = upstream.SetReadDeadline(time.Time{})

	if websocket {
		if !validWebSocketResponse(request, response) {
			writeErrorResponse(connection, http.StatusBadGateway)
			return
		}
		prepareWebSocketResponse(response)
		if err := writeResponseHead(connection, response, false); err != nil {
			return
		}
		tunnel(connection, requestReader, upstream, responseReader)
		return
	}
	if response.StatusCode < 200 || response.StatusCode == http.StatusSwitchingProtocols || response.Trailer != nil || hasHeader(response.Header, "Trailer") {
		writeErrorResponse(connection, http.StatusBadGateway)
		return
	}
	if hasContentLengthTransferEncodingAmbiguity(responseHeader) {
		writeErrorResponse(connection, http.StatusBadGateway)
		return
	}
	if _, ok := connectionHeaderNames(response.Header); !ok {
		writeErrorResponse(connection, http.StatusBadGateway)
		return
	}
	stripHopByHop(response.Header)
	response.Close = true
	if err := writeResponseHead(connection, response, responseHasBody(request.Method, response.StatusCode)); err != nil {
		return
	}
	_ = streamResponseBody(connection, response, request.Method)
}

func readHeader(reader *bufio.Reader) ([]byte, error) {
	var header bytes.Buffer
	for header.Len() <= MaximumHeaderBytes {
		fragment, err := reader.ReadSlice('\n')
		if header.Len()+len(fragment) > MaximumHeaderBytes {
			return nil, errors.New("HTTP header is too large")
		}
		_, _ = header.Write(fragment)
		if err == nil {
			value := header.Bytes()
			if len(value) >= 4 && bytes.Equal(value[len(value)-4:], []byte("\r\n\r\n")) {
				if err := validateRawHeader(value); err != nil {
					return nil, err
				}
				return value, nil
			}
			continue
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return nil, errors.New("incomplete HTTP header")
		}
	}
	return nil, errors.New("HTTP header is too large")
}

func validateRawHeader(header []byte) error {
	lines := bytes.Split(header, []byte("\r\n"))
	if len(lines) < 3 || len(lines[0]) == 0 {
		return errors.New("malformed HTTP header")
	}
	fieldCount := 0
	for _, line := range lines[1:] {
		if len(line) == 0 {
			break
		}
		fieldCount++
		if fieldCount > MaximumHeaderFields {
			return errors.New("too many HTTP header fields")
		}
		if line[0] == ' ' || line[0] == '\t' || bytes.IndexByte(line, 0) >= 0 {
			return errors.New("obsolete or invalid HTTP header folding")
		}
	}
	return nil
}

func validateRequest(request *http.Request, rawHeader []byte) (bool, int) {
	if request.ProtoMajor != 1 || request.ProtoMinor != 1 || len(request.RequestURI) == 0 || len(request.RequestURI) > MaximumRequestTarget {
		return false, http.StatusBadRequest
	}
	if !strings.HasPrefix(request.RequestURI, "/") || request.URL.IsAbs() || request.URL.Host != "" || request.URL.Fragment != "" {
		return false, http.StatusBadRequest
	}
	if request.Method == http.MethodConnect || request.Method == http.MethodTrace {
		return false, http.StatusMethodNotAllowed
	}
	if hasContentLengthTransferEncodingAmbiguity(rawHeader) {
		return false, http.StatusBadRequest
	}
	if request.ContentLength > MaximumRequestBodyBytes {
		return false, http.StatusRequestEntityTooLarge
	}
	if request.Trailer != nil || hasHeader(request.Header, "Trailer") || hasHeader(request.Header, "Expect") {
		return false, http.StatusBadRequest
	}
	connectionNames, ok := connectionHeaderNames(request.Header)
	if !ok {
		return false, http.StatusBadRequest
	}
	upgrade := hasHeader(request.Header, "Upgrade") || connectionNames["upgrade"]
	if upgrade {
		if !validWebSocketRequest(request) {
			return false, http.StatusUpgradeRequired
		}
		return true, 0
	}
	return false, 0
}

func prepareRequest(request *http.Request, host string, websocket bool) {
	stripHopByHop(request.Header)
	request.RequestURI = ""
	request.URL.Scheme = ""
	request.URL.Host = ""
	request.Host = host
	request.Close = !websocket
	request.Header.Del("Sec-WebSocket-Extensions")
	if websocket {
		request.Header.Set("Connection", "Upgrade")
		request.Header.Set("Upgrade", "websocket")
	} else {
		request.Header.Set("Connection", "close")
	}
}

func stripHopByHop(header http.Header) {
	connectionNames, _ := connectionHeaderNames(header)
	for name := range connectionNames {
		header.Del(name)
	}
	for name := range header {
		lower := strings.ToLower(name)
		if lower == "connection" || lower == "keep-alive" || lower == "te" || lower == "trailer" || lower == "transfer-encoding" || lower == "upgrade" || strings.HasPrefix(lower, "proxy-") || lower == "forwarded" || strings.HasPrefix(lower, "x-forwarded-") || lower == "x-real-ip" || strings.HasPrefix(lower, "microvm-") {
			header.Del(name)
		}
	}
}

func connectionHeaderNames(header http.Header) (map[string]bool, bool) {
	result := make(map[string]bool)
	for _, value := range header.Values("Connection") {
		for _, item := range strings.Split(value, ",") {
			name := strings.TrimSpace(item)
			if name == "" || !validToken(name) {
				return nil, false
			}
			result[strings.ToLower(name)] = true
		}
	}
	return result, true
}

func validToken(value string) bool {
	if value == "" {
		return false
	}
	for index := range len(value) {
		character := value[index]
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') {
			continue
		}
		switch character {
		case '!', '#', '$', '%', '&', '\'', '*', '+', '-', '.', '^', '_', '`', '|', '~':
			continue
		}
		return false
	}
	return true
}

func validWebSocketRequest(request *http.Request) bool {
	if request.Method != http.MethodGet || request.ContentLength > 0 || len(request.TransferEncoding) != 0 {
		return false
	}
	connectionNames, ok := connectionHeaderNames(request.Header)
	if !ok || !connectionNames["upgrade"] || !singleHeaderEqual(request.Header, "Upgrade", "websocket") || !singleHeaderEqual(request.Header, "Sec-WebSocket-Version", "13") {
		return false
	}
	values := request.Header.Values("Sec-WebSocket-Key")
	if len(values) != 1 {
		return false
	}
	if _, ok := webSocketProtocols(request.Header); !ok {
		return false
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(values[0]))
	return err == nil && len(decoded) == 16
}

func validWebSocketResponse(request *http.Request, response *http.Response) bool {
	if response.StatusCode != http.StatusSwitchingProtocols || !singleHeaderEqual(response.Header, "Upgrade", "websocket") || hasHeader(response.Header, "Sec-WebSocket-Extensions") {
		return false
	}
	connectionNames, ok := connectionHeaderNames(response.Header)
	if !ok || !connectionNames["upgrade"] {
		return false
	}
	keys := request.Header.Values("Sec-WebSocket-Key")
	accepts := response.Header.Values("Sec-WebSocket-Accept")
	if len(keys) != 1 || len(accepts) != 1 {
		return false
	}
	offered, valid := webSocketProtocols(request.Header)
	if !valid {
		return false
	}
	selected, valid := webSocketProtocols(response.Header)
	if !valid || len(selected) > 1 {
		return false
	}
	if len(selected) == 1 {
		matched := false
		for _, protocol := range offered {
			if protocol == selected[0] {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	digest := sha1.Sum([]byte(strings.TrimSpace(keys[0]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return strings.TrimSpace(accepts[0]) == base64.StdEncoding.EncodeToString(digest[:])
}

func prepareWebSocketResponse(response *http.Response) {
	upgrade := response.Header.Get("Upgrade")
	stripHopByHop(response.Header)
	response.Header.Set("Connection", "Upgrade")
	response.Header.Set("Upgrade", upgrade)
	response.Close = false
}

func singleHeaderEqual(header http.Header, name, wanted string) bool {
	values := header.Values(name)
	return len(values) == 1 && strings.EqualFold(strings.TrimSpace(values[0]), wanted)
}

func webSocketProtocols(header http.Header) ([]string, bool) {
	values := header.Values("Sec-WebSocket-Protocol")
	if len(values) == 0 {
		return nil, true
	}
	protocols := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		for _, item := range strings.Split(value, ",") {
			protocol := strings.TrimSpace(item)
			if !validToken(protocol) {
				return nil, false
			}
			if _, duplicate := seen[protocol]; duplicate {
				return nil, false
			}
			seen[protocol] = struct{}{}
			protocols = append(protocols, protocol)
		}
	}
	return protocols, true
}

func hasHeader(header http.Header, name string) bool {
	_, ok := header[http.CanonicalHeaderKey(name)]
	return ok
}

func hasContentLengthTransferEncodingAmbiguity(rawHeader []byte) bool {
	return rawHeaderContains(rawHeader, "content-length") && rawHeaderContains(rawHeader, "transfer-encoding")
}

func rawHeaderContains(rawHeader []byte, wanted string) bool {
	lines := bytes.Split(rawHeader, []byte("\r\n"))
	for _, line := range lines[1:] {
		separator := bytes.IndexByte(line, ':')
		if separator > 0 && strings.EqualFold(string(line[:separator]), wanted) {
			return true
		}
	}
	return false
}

type boundedRequestBody struct {
	body       io.ReadCloser
	connection net.Conn
	remaining  int64
}

func (b *boundedRequestBody) Read(buffer []byte) (int, error) {
	if b.remaining == 0 {
		var extra [1]byte
		_ = b.connection.SetReadDeadline(time.Now().Add(UploadIdleTimeout))
		count, err := b.body.Read(extra[:])
		if count != 0 || err == nil {
			return 0, errRequestBodyTooLarge
		}
		return 0, err
	}
	if int64(len(buffer)) > b.remaining {
		buffer = buffer[:b.remaining]
	}
	_ = b.connection.SetReadDeadline(time.Now().Add(UploadIdleTimeout))
	count, err := b.body.Read(buffer)
	b.remaining -= int64(count)
	return count, err
}

func (b *boundedRequestBody) Close() error { return b.body.Close() }

func writeResponseHead(writer io.Writer, response *http.Response, withBody bool) error {
	statusText := http.StatusText(response.StatusCode)
	if statusText == "" {
		statusText = "Status"
	}
	if _, err := fmt.Fprintf(writer, "HTTP/1.1 %d %s\r\n", response.StatusCode, statusText); err != nil {
		return err
	}
	header := response.Header.Clone()
	if response.StatusCode == http.StatusSwitchingProtocols {
		header.Del("Content-Length")
		header.Del("Transfer-Encoding")
	} else if withBody {
		if response.ContentLength >= 0 {
			header.Set("Content-Length", strconv.FormatInt(response.ContentLength, 10))
			header.Del("Transfer-Encoding")
		} else {
			header.Del("Content-Length")
			header.Set("Transfer-Encoding", "chunked")
		}
		header.Set("Connection", "close")
	} else {
		header.Del("Transfer-Encoding")
		header.Set("Connection", "close")
	}
	return writeHeaders(writer, header)
}

func writeHeaders(writer io.Writer, header http.Header) error {
	names := make([]string, 0, len(header))
	for name := range header {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		for _, value := range header.Values(name) {
			if _, err := fmt.Fprintf(writer, "%s: %s\r\n", name, value); err != nil {
				return err
			}
		}
	}
	_, err := io.WriteString(writer, "\r\n")
	return err
}

func responseHasBody(method string, status int) bool {
	return method != http.MethodHead && status >= 200 && status != http.StatusNoContent && status != http.StatusNotModified
}

func streamResponseBody(writer io.Writer, response *http.Response, method string) error {
	if !responseHasBody(method, response.StatusCode) {
		return nil
	}
	if response.ContentLength >= 0 {
		_, err := io.Copy(writer, response.Body)
		return err
	}
	buffer := make([]byte, 32<<10)
	for {
		count, readErr := response.Body.Read(buffer)
		if count > 0 {
			if _, err := fmt.Fprintf(writer, "%x\r\n", count); err != nil {
				return err
			}
			if _, err := writer.Write(buffer[:count]); err != nil {
				return err
			}
			if _, err := io.WriteString(writer, "\r\n"); err != nil {
				return err
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				_, err := io.WriteString(writer, "0\r\n\r\n")
				return err
			}
			return readErr
		}
	}
}

func closeUpstreamOnOuterDisconnect(reader io.Reader, upstream net.Conn) {
	var probe [1]byte
	count, err := reader.Read(probe[:])
	if count == 0 && err != nil {
		_ = upstream.Close()
	}
}

func tunnel(outer net.Conn, outerReader io.Reader, upstream net.Conn, upstreamReader io.Reader) {
	_ = outer.SetDeadline(time.Time{})
	_ = upstream.SetDeadline(time.Time{})
	done := make(chan struct{}, 2)
	copyOneWay := func(destination net.Conn, source io.Reader) {
		_, _ = io.Copy(destination, source)
		if closer, ok := destination.(interface{ CloseWrite() error }); ok {
			_ = closer.CloseWrite()
		}
		done <- struct{}{}
	}
	go copyOneWay(upstream, outerReader)
	go copyOneWay(outer, upstreamReader)
	<-done
	_ = outer.Close()
	_ = upstream.Close()
	<-done
}

func writeDialError(writer io.Writer, err error) {
	var netError net.Error
	if errors.As(err, &netError) && netError.Timeout() {
		writeErrorResponse(writer, http.StatusGatewayTimeout)
		return
	}
	writeErrorResponse(writer, http.StatusServiceUnavailable)
}

func writeUpstreamError(writer io.Writer, err error) {
	var netError net.Error
	if errors.As(err, &netError) && netError.Timeout() {
		writeErrorResponse(writer, http.StatusGatewayTimeout)
		return
	}
	writeErrorResponse(writer, http.StatusBadGateway)
}

func writeErrorResponse(writer io.Writer, status int) {
	message := http.StatusText(status)
	body := message + "\n"
	_, _ = fmt.Fprintf(writer, "HTTP/1.1 %d %s\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: %d\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n%s", status, message, len(body), body)
}
