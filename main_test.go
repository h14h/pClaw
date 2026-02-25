package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

type capturedToolEventSink struct {
	events []ToolEvent
}

func (s *capturedToolEventSink) HandleToolEvent(_ context.Context, event ToolEvent) {
	s.events = append(s.events, event)
}

type capturedServerEventSink struct {
	events []ServerEvent
}

func (s *capturedServerEventSink) HandleServerEvent(_ context.Context, event ServerEvent) {
	s.events = append(s.events, event)
}

func TestReadFile(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(filePath, []byte("hello"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	input, err := json.Marshal(ReadFileInput{Path: filePath})
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}

	out, err := ReadFile(input)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if out != "hello" {
		t.Fatalf("expected content %q, got %q", "hello", out)
	}
}

func TestListFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644); err != nil {
		t.Fatalf("write a.txt: %v", err)
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatalf("mkdir sub: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sub", "b.txt"), []byte("b"), 0o644); err != nil {
		t.Fatalf("write b.txt: %v", err)
	}

	input, err := json.Marshal(ListFilesInput{Path: dir})
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}

	out, err := ListFiles(input)
	if err != nil {
		t.Fatalf("ListFiles: %v", err)
	}

	var files []string
	if err := json.Unmarshal([]byte(out), &files); err != nil {
		t.Fatalf("unmarshal output: %v", err)
	}

	if slices.Contains(files, ".") {
		t.Fatalf("unexpected dot entry in list: %v", files)
	}
	for _, expected := range []string{"a.txt", "sub/"} {
		if !slices.Contains(files, expected) {
			t.Fatalf("expected %q in list, got %v", expected, files)
		}
	}
}

func TestEditFileReplace(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(filePath, []byte("hello world"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	input, err := json.Marshal(EditFileInput{
		Path:   filePath,
		OldStr: "world",
		NewStr: "gophers",
	})
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}

	out, err := EditFile(input)
	if err != nil {
		t.Fatalf("EditFile: %v", err)
	}
	if out != "OK" {
		t.Fatalf("expected OK response, got %q", out)
	}

	updated, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("read updated file: %v", err)
	}
	if string(updated) != "hello gophers" {
		t.Fatalf("expected updated content, got %q", string(updated))
	}
}

func TestEditFileCreate(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "sub", "new.txt")

	input, err := json.Marshal(EditFileInput{
		Path:   filePath,
		OldStr: "",
		NewStr: "new content",
	})
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}

	out, err := EditFile(input)
	if err != nil {
		t.Fatalf("EditFile create: %v", err)
	}
	if out == "" {
		t.Fatal("expected non-empty create response")
	}

	created, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("read created file: %v", err)
	}
	if string(created) != "new content" {
		t.Fatalf("expected created content, got %q", string(created))
	}
}

func TestEditFileInvalidInput(t *testing.T) {
	input, err := json.Marshal(EditFileInput{
		Path:   "",
		OldStr: "a",
		NewStr: "b",
	})
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}
	if _, err := EditFile(input); err == nil {
		t.Fatal("expected error for empty path")
	}

	input, err = json.Marshal(EditFileInput{
		Path:   "note.txt",
		OldStr: "same",
		NewStr: "same",
	})
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}
	if _, err := EditFile(input); err == nil {
		t.Fatal("expected error for identical old/new strings")
	}
}

func TestExecuteToolNotFound(t *testing.T) {
	agent := NewAgent("http://example.com", "key", nil, nil, nil)
	msg := agent.executeTool(context.Background(), ChatToolCall{
		ID:   "call_1",
		Type: "function",
		Function: ChatToolCallFunction{
			Name:      "missing",
			Arguments: "{}",
		},
	})
	if msg.Role != "tool" {
		t.Fatalf("expected tool role, got %q", msg.Role)
	}
	if msg.Content != "tool not found" {
		t.Fatalf("expected tool not found, got %v", msg.Content)
	}
}

func TestExecuteToolArgs(t *testing.T) {
	echoTool := ToolDefinition{
		Name:        "echo",
		Description: "Echo input.",
		InputSchema: map[string]interface{}{"type": "object"},
		Function: func(input json.RawMessage) (string, error) {
			var payload struct {
				Value string `json:"value"`
			}
			if err := json.Unmarshal(input, &payload); err != nil {
				return "", err
			}
			return payload.Value, nil
		},
	}

	agent := NewAgent("http://example.com", "key", nil, nil, []ToolDefinition{echoTool})
	args, err := json.Marshal(map[string]string{"value": "ok"})
	if err != nil {
		t.Fatalf("marshal args: %v", err)
	}

	msg := agent.executeTool(context.Background(), ChatToolCall{
		ID:   "call_2",
		Type: "function",
		Function: ChatToolCallFunction{
			Name:      "echo",
			Arguments: string(args),
		},
	})
	if msg.Role != "tool" {
		t.Fatalf("expected tool role, got %q", msg.Role)
	}
	if msg.Content != "ok" {
		t.Fatalf("expected ok response, got %v", msg.Content)
	}
}

func TestExecuteToolEmitsStartedAndSucceededEvents(t *testing.T) {
	echoTool := ToolDefinition{
		Name:        "echo",
		Description: "Echo input.",
		InputSchema: map[string]interface{}{"type": "object"},
		Function: func(input json.RawMessage) (string, error) {
			var payload struct {
				Value string `json:"value"`
			}
			if err := json.Unmarshal(input, &payload); err != nil {
				return "", err
			}
			return payload.Value, nil
		},
	}

	agent := NewAgent("http://example.com", "key", nil, nil, []ToolDefinition{echoTool})
	sink := &capturedToolEventSink{}
	agent.toolEventSink = sink

	msg := agent.executeTool(context.Background(), ChatToolCall{
		ID:   "call_evt_1",
		Type: "function",
		Function: ChatToolCallFunction{
			Name:      "echo",
			Arguments: `{"value":"ok"}`,
		},
	})
	if msg.Content != "ok" {
		t.Fatalf("expected ok content, got %v", msg.Content)
	}
	if len(sink.events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(sink.events))
	}
	if sink.events[0].Type != ToolEventStarted {
		t.Fatalf("expected first event started, got %s", sink.events[0].Type)
	}
	if sink.events[1].Type != ToolEventSucceeded {
		t.Fatalf("expected second event succeeded, got %s", sink.events[1].Type)
	}
}

func TestExecuteToolEmitsFailedEventForMissingTool(t *testing.T) {
	agent := NewAgent("http://example.com", "key", nil, nil, nil)
	sink := &capturedToolEventSink{}
	agent.toolEventSink = sink

	msg := agent.executeTool(context.Background(), ChatToolCall{
		ID:   "call_evt_2",
		Type: "function",
		Function: ChatToolCallFunction{
			Name:      "missing",
			Arguments: "{}",
		},
	})
	if msg.Content != "tool not found" {
		t.Fatalf("expected tool not found, got %v", msg.Content)
	}
	if len(sink.events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(sink.events))
	}
	if sink.events[0].Type != ToolEventStarted {
		t.Fatalf("expected first event started, got %s", sink.events[0].Type)
	}
	if sink.events[1].Type != ToolEventFailed {
		t.Fatalf("expected second event failed, got %s", sink.events[1].Type)
	}
	if sink.events[1].Err != "tool not found" {
		t.Fatalf("expected tool not found error, got %q", sink.events[1].Err)
	}
}

func TestCLIToolEventSinkDebugOutput(t *testing.T) {
	buf := &bytes.Buffer{}
	sink := &CLIToolEventSink{out: buf}

	sink.HandleToolEvent(context.Background(), ToolEvent{
		Type:       ToolEventStarted,
		ToolCallID: "call_1",
		ToolName:   "read_file",
		ArgsRaw:    `{"path":"note.txt"}`,
		ArgsParsed: map[string]interface{}{
			"path": "note.txt",
		},
	})
	sink.HandleToolEvent(context.Background(), ToolEvent{
		Type:       ToolEventSucceeded,
		ToolCallID: "call_1",
		ToolName:   "list_files",
		ResultRaw:  `["a.txt","sub/"]`,
		ArgsParsed: map[string]interface{}{
			"path": ".",
		},
		Duration: time.Millisecond,
	})
	sink.HandleToolEvent(context.Background(), ToolEvent{
		Type:       ToolEventFailed,
		ToolCallID: "call_2",
		ToolName:   "delegate_reasoning",
		Err:        "timeout",
		Duration:   5 * time.Millisecond,
	})

	out := buf.String()
	for _, expected := range []string{
		`tool_event type=tool_call.started call_id="call_1" tool="read_file" args={"path":"note.txt"}`,
		`tool_event type=tool_call.succeeded call_id="call_1" tool="list_files" duration_ms=1 result_bytes=16`,
		`tool_event type=tool_call.failed call_id="call_2" tool="delegate_reasoning" duration_ms=5 error="timeout"`,
	} {
		if !strings.Contains(out, expected) {
			t.Fatalf("expected output to contain %q, got %q", expected, out)
		}
	}
}

func TestParseToolEventLogMode(t *testing.T) {
	cases := []struct {
		name  string
		in    string
		want  ToolEventLogMode
		valid bool
	}{
		{name: "empty", in: "", want: ToolEventLogOff, valid: true},
		{name: "off", in: "off", want: ToolEventLogOff, valid: true},
		{name: "debug", in: "debug", want: ToolEventLogDebug, valid: true},
		{name: "mixed case", in: "DeBuG", want: ToolEventLogDebug, valid: true},
		{name: "invalid", in: "verbose", want: ToolEventLogOff, valid: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseToolEventLogMode(tc.in)
			if ok != tc.valid {
				t.Fatalf("expected valid=%v, got %v", tc.valid, ok)
			}
			if got != tc.want {
				t.Fatalf("expected mode %q, got %q", tc.want, got)
			}
		})
	}
}

func TestParseServerEventLogMode(t *testing.T) {
	cases := []struct {
		name  string
		in    string
		want  ServerEventLogMode
		valid bool
	}{
		{name: "empty", in: "", want: ServerEventLogOff, valid: true},
		{name: "off", in: "off", want: ServerEventLogOff, valid: true},
		{name: "line", in: "line", want: ServerEventLogLine, valid: true},
		{name: "verbose", in: "verbose", want: ServerEventLogVerbose, valid: true},
		{name: "mixed case", in: "LiNe", want: ServerEventLogLine, valid: true},
		{name: "invalid", in: "json", want: ServerEventLogOff, valid: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseServerEventLogMode(tc.in)
			if ok != tc.valid {
				t.Fatalf("expected valid=%v, got %v", tc.valid, ok)
			}
			if got != tc.want {
				t.Fatalf("expected mode %q, got %q", tc.want, got)
			}
		})
	}
}

func TestServerEventSinkIncludesVerboseContent(t *testing.T) {
	if serverEventSinkIncludesVerboseContent(nil) {
		t.Fatal("nil sink should not be verbose")
	}
	if serverEventSinkIncludesVerboseContent(&LineServerEventSink{out: io.Discard}) {
		t.Fatal("line sink should not be verbose")
	}
	if !serverEventSinkIncludesVerboseContent(&LineServerEventSink{out: io.Discard, verboseContent: true}) {
		t.Fatal("verbose line sink should be verbose")
	}
}

func TestLineServerEventSinkFormatsReadableLine(t *testing.T) {
	buf := &bytes.Buffer{}
	sink := &LineServerEventSink{out: buf}
	sink.HandleServerEvent(context.Background(), ServerEvent{
		TS:         time.Date(2026, 2, 21, 20, 22, 10, 104000000, time.UTC),
		Level:      ServerLogLevelInfo,
		Event:      "tool_call.succeeded",
		Message:    "tool execution succeeded",
		TraceID:    "trc_1",
		TurnID:     "turn_2",
		SessionKey: "c:u",
		Source:     "discord",
		ChannelID:  "c",
		UserIDHash: "sha256:abcd",
		Fields: map[string]interface{}{
			"duration_ms": 34,
			"tool":        "read_file",
		},
	})

	out := strings.TrimSpace(buf.String())
	for _, expected := range []string{
		"2026-02-21T20:22:10.104Z INFO",
		"event=tool_call.succeeded",
		"trace=trc_1",
		"turn=turn_2",
		"session=c:u",
		"msg=\"tool execution succeeded\"",
		"source=discord",
		"channel=c",
		"user=sha256:abcd",
		"duration_ms=34",
		"tool=read_file",
	} {
		if !strings.Contains(out, expected) {
			t.Fatalf("expected %q in output, got %q", expected, out)
		}
	}
}

func TestEmitToolEventAlsoEmitsServerEvent(t *testing.T) {
	agent := NewAgent("http://example.com", "key", nil, nil, nil)
	serverSink := &capturedServerEventSink{}
	agent.serverEventSink = serverSink

	agent.emitToolEvent(context.Background(), ToolEvent{
		Type:       ToolEventSucceeded,
		ToolCallID: "call_1",
		ToolName:   "read_file",
		ResultRaw:  "abc",
		Duration:   5 * time.Millisecond,
	})

	if len(serverSink.events) != 1 {
		t.Fatalf("expected one server event, got %d", len(serverSink.events))
	}
	ev := serverSink.events[0]
	if ev.Event != string(ToolEventSucceeded) {
		t.Fatalf("expected event %q, got %q", ToolEventSucceeded, ev.Event)
	}
	if ev.Fields["tool"] != "read_file" {
		t.Fatalf("expected tool field read_file, got %v", ev.Fields["tool"])
	}
}

func TestNewAgentDefaultsToNoToolEventSink(t *testing.T) {
	agent := NewAgent("http://example.com", "key", nil, nil, nil)
	if agent.toolEventSink != nil {
		t.Fatalf("expected nil default toolEventSink, got %T", agent.toolEventSink)
	}
}

func TestNewAgentDefaults(t *testing.T) {
	agent := NewAgent("http://example.com", "key", nil, nil, nil)

	if agent.primaryModel != Instruct {
		t.Fatalf("expected primary model %q, got %q", Instruct, agent.primaryModel)
	}
	if agent.reasoningModel != Reasoning {
		t.Fatalf("expected reasoning model %q, got %q", Reasoning, agent.reasoningModel)
	}

	found := false
	for _, tool := range agent.tools {
		if tool.Name == "delegate_reasoning" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("expected delegate_reasoning tool to be registered")
	}
}

func TestRunInferenceUsesPrimaryModel(t *testing.T) {
	var seenModel string
	var seenMessages []ChatMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		var req ChatCompletionRequest
		if err := json.Unmarshal(body, &req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		seenModel = req.Model
		seenMessages = req.Messages
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","model":"` + req.Model + `","choices":[{"index":0,"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer server.Close()

	agent := NewAgent(server.URL, "key", server.Client(), nil, nil)
	_, err := agent.runInference(context.Background(), []ChatMessage{{Role: "user", Content: "hi"}})
	if err != nil {
		t.Fatalf("runInference: %v", err)
	}
	if seenModel != string(Instruct) {
		t.Fatalf("expected model %q, got %q", Instruct, seenModel)
	}
	if len(seenMessages) < 2 || seenMessages[0].Role != "system" {
		t.Fatalf("expected leading system message, got %#v", seenMessages)
	}
	if seenMessages[1].Role != "user" {
		t.Fatalf("expected user message after system, got %#v", seenMessages[1])
	}
}

func TestRunInferenceStream_UsesStreamAndEmitsText(t *testing.T) {
	var seenModel string
	var seenStream bool
	var seenMessages []ChatMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		var req ChatCompletionRequest
		if err := json.Unmarshal(body, &req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		seenModel = req.Model
		seenStream = req.Stream
		seenMessages = req.Messages

		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\" world\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	agent := NewAgent(server.URL, "key", server.Client(), nil, nil)
	var streamed strings.Builder
	msg, err := agent.runInferenceStream(context.Background(), []ChatMessage{{Role: "user", Content: "hi"}}, func(delta string) {
		streamed.WriteString(delta)
	})
	if err != nil {
		t.Fatalf("runInferenceStream: %v", err)
	}
	if !seenStream {
		t.Fatal("expected stream=true in request")
	}
	if seenModel != string(Instruct) {
		t.Fatalf("expected model %q, got %q", Instruct, seenModel)
	}
	if len(seenMessages) < 2 || seenMessages[0].Role != "system" {
		t.Fatalf("expected leading system message in stream request, got %#v", seenMessages)
	}
	if streamed.String() != "Hello world" {
		t.Fatalf("expected streamed text %q, got %q", "Hello world", streamed.String())
	}
	text, ok := msg.Content.(string)
	if !ok {
		t.Fatalf("expected string content, got %T", msg.Content)
	}
	if text != "Hello world" {
		t.Fatalf("expected final content %q, got %q", "Hello world", text)
	}
}

func TestRunInferenceStream_ReconstructsToolCalls(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"\"}}]}}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"note.txt\\\"}\"}}]}}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	agent := NewAgent(server.URL, "key", server.Client(), nil, nil)
	msg, err := agent.runInferenceStream(context.Background(), []ChatMessage{{Role: "user", Content: "hi"}}, nil)
	if err != nil {
		t.Fatalf("runInferenceStream: %v", err)
	}

	if len(msg.ToolCalls) != 1 {
		t.Fatalf("expected one tool call, got %d", len(msg.ToolCalls))
	}
	call := msg.ToolCalls[0]
	if call.ID != "call_1" {
		t.Fatalf("expected call id %q, got %q", "call_1", call.ID)
	}
	if call.Function.Name != "read_file" {
		t.Fatalf("expected function name %q, got %q", "read_file", call.Function.Name)
	}
	if call.Function.Arguments != "{\"path\":\"note.txt\"}" {
		t.Fatalf("unexpected function arguments: %q", call.Function.Arguments)
	}
}

func TestDelegateReasoningUsesReasoningModel(t *testing.T) {
	var seenModel string
	var seenTools int
	var seenMessages []ChatMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		var req ChatCompletionRequest
		if err := json.Unmarshal(body, &req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		seenModel = req.Model
		seenTools = len(req.Tools)
		seenMessages = req.Messages
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","model":"` + req.Model + `","choices":[{"index":0,"message":{"role":"assistant","content":"reasoned"}}]}`))
	}))
	defer server.Close()

	agent := NewAgent(server.URL, "key", server.Client(), nil, nil)
	out, err := agent.delegateReasoning(json.RawMessage(`{"question":"why","context":"ctx"}`))
	if err != nil {
		t.Fatalf("delegateReasoning: %v", err)
	}
	if strings.TrimSpace(out) == "" {
		t.Fatal("expected non-empty response")
	}
	if seenModel != string(Reasoning) {
		t.Fatalf("expected model %q, got %q", Reasoning, seenModel)
	}
	if seenTools != 0 {
		t.Fatalf("expected no tools in reasoning call, got %d", seenTools)
	}
	if len(seenMessages) < 2 || seenMessages[0].Role != "system" {
		t.Fatalf("expected leading system message in reasoning call, got %#v", seenMessages)
	}
	systemPrompt, _ := seenMessages[0].Content.(string)
	if strings.Contains(systemPrompt, "[Identity]") {
		t.Fatalf("did not expect Identity section in minimal mode prompt: %s", systemPrompt)
	}
	if !strings.Contains(systemPrompt, "[Behavior]") {
		t.Fatalf("expected Behavior section in minimal mode prompt: %s", systemPrompt)
	}
}

func TestDelegateReasoningLimit(t *testing.T) {
	agent := NewAgent("http://example.com", "key", nil, nil, nil)
	agent.reasoningCallCount = defaultReasoningLimit

	_, err := agent.delegateReasoning(json.RawMessage(`{"question":"why"}`))
	if err == nil {
		t.Fatal("expected limit error")
	}
	if !strings.Contains(err.Error(), "limit") {
		t.Fatalf("expected limit error message, got %v", err)
	}
}

func TestHandleUserMessage_ToolLoopAndFinalText(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		var req ChatCompletionRequest
		if err := json.Unmarshal(body, &req); err != nil {
			t.Fatalf("decode request: %v", err)
		}

		hasToolResult := false
		for _, msg := range req.Messages {
			if msg.Role == "tool" {
				hasToolResult = true
				break
			}
		}

		w.Header().Set("Content-Type", "application/json")
		if !hasToolResult {
			_, _ = w.Write([]byte(`{"id":"x","model":"kimi-k2-instruct","choices":[{"index":0,"message":{"role":"assistant","tool_calls":[{"id":"call_1","type":"function","function":{"name":"echo","arguments":"{\"value\":\"ok\"}"}}]}}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"x","model":"kimi-k2-instruct","choices":[{"index":0,"message":{"role":"assistant","content":"done"}}]}`))
	}))
	defer server.Close()

	echoTool := ToolDefinition{
		Name:        "echo",
		Description: "Echo input.",
		InputSchema: map[string]interface{}{"type": "object"},
		Function: func(input json.RawMessage) (string, error) {
			var payload struct {
				Value string `json:"value"`
			}
			if err := json.Unmarshal(input, &payload); err != nil {
				return "", err
			}
			return payload.Value, nil
		},
	}

	agent := NewAgent(server.URL, "key", server.Client(), nil, []ToolDefinition{echoTool})
	updatedCS, response, err := agent.HandleUserMessage(context.Background(), NewConversationState(), "test")
	if err != nil {
		t.Fatalf("HandleUserMessage: %v", err)
	}
	if response != "done" {
		t.Fatalf("expected final response %q, got %q", "done", response)
	}
	if len(updatedCS.Messages) != 4 {
		t.Fatalf("expected 4 messages in conversation, got %d", len(updatedCS.Messages))
	}
}

func TestHandleUserMessageProgressive_EmitsPartsInOrder(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		var req ChatCompletionRequest
		if err := json.Unmarshal(body, &req); err != nil {
			t.Fatalf("decode request: %v", err)
		}

		hasToolResult := false
		for _, msg := range req.Messages {
			if msg.Role == "tool" {
				hasToolResult = true
				break
			}
		}

		w.Header().Set("Content-Type", "application/json")
		if !hasToolResult {
			_, _ = w.Write([]byte(`{"id":"x","model":"kimi-k2-instruct","choices":[{"index":0,"message":{"role":"assistant","content":"let me think for a bit","tool_calls":[{"id":"call_1","type":"function","function":{"name":"echo","arguments":"{\"value\":\"ok\"}"}}]}}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"x","model":"kimi-k2-instruct","choices":[{"index":0,"message":{"role":"assistant","content":"final answer"}}]}`))
	}))
	defer server.Close()

	echoTool := ToolDefinition{
		Name:        "echo",
		Description: "Echo input.",
		InputSchema: map[string]interface{}{"type": "object"},
		Function: func(input json.RawMessage) (string, error) {
			return "ok", nil
		},
	}

	var gotParts []string
	agent := NewAgent(server.URL, "key", server.Client(), nil, []ToolDefinition{echoTool})
	updatedCS, response, err := agent.HandleUserMessageProgressive(context.Background(), NewConversationState(), "test", func(part string) error {
		gotParts = append(gotParts, part)
		return nil
	})
	if err != nil {
		t.Fatalf("HandleUserMessageProgressive: %v", err)
	}
	if len(gotParts) != 2 {
		t.Fatalf("expected 2 parts, got %d", len(gotParts))
	}
	if gotParts[0] != "let me think for a bit" || gotParts[1] != "final answer" {
		t.Fatalf("unexpected parts: %#v", gotParts)
	}
	if response != "let me think for a bit\n\nfinal answer" {
		t.Fatalf("unexpected final response: %q", response)
	}
	if len(updatedCS.Messages) != 4 {
		t.Fatalf("expected 4 messages in conversation, got %d", len(updatedCS.Messages))
	}
}

func TestRunInference_UsesRAGEndpoint(t *testing.T) {
	var seenPath string
	var seenBody ChatCompletionRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &seenBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","model":"test","choices":[{"index":0,"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer server.Close()

	client := NewMemoryClient(server.URL, "key", server.Client())
	client.mu.Lock()
	client.collectionID = "col-123"
	client.mu.Unlock()

	agent := NewAgent(server.URL, "key", server.Client(), nil, nil)
	agent.memoryClient = client

	_, err := agent.runInference(context.Background(), []ChatMessage{{Role: "user", Content: "hi"}})
	if err != nil {
		t.Fatalf("runInference: %v", err)
	}
	if seenPath != "/chat/completions/RAG" {
		t.Fatalf("expected path /chat/completions/RAG, got %q", seenPath)
	}
	if seenBody.Collection != "col-123" {
		t.Fatalf("expected collection %q, got %q", "col-123", seenBody.Collection)
	}
}

func TestRunInference_NoRAGWithoutMemory(t *testing.T) {
	var seenPath string
	var seenBody ChatCompletionRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &seenBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","model":"test","choices":[{"index":0,"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer server.Close()

	agent := NewAgent(server.URL, "key", server.Client(), nil, nil)

	_, err := agent.runInference(context.Background(), []ChatMessage{{Role: "user", Content: "hi"}})
	if err != nil {
		t.Fatalf("runInference: %v", err)
	}
	if seenPath != "/chat/completions" {
		t.Fatalf("expected path /chat/completions, got %q", seenPath)
	}
	if seenBody.Collection != "" {
		t.Fatalf("expected no collection, got %q", seenBody.Collection)
	}
}

func TestRunInferenceStream_UsesRAGEndpoint(t *testing.T) {
	var seenPath string
	var seenBody ChatCompletionRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &seenBody)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	client := NewMemoryClient(server.URL, "key", server.Client())
	client.mu.Lock()
	client.collectionID = "col-123"
	client.mu.Unlock()

	agent := NewAgent(server.URL, "key", server.Client(), nil, nil)
	agent.memoryClient = client

	_, err := agent.runInferenceStream(context.Background(), []ChatMessage{{Role: "user", Content: "hi"}}, nil)
	if err != nil {
		t.Fatalf("runInferenceStream: %v", err)
	}
	if seenPath != "/chat/completions/RAG" {
		t.Fatalf("expected path /chat/completions/RAG, got %q", seenPath)
	}
	if seenBody.Collection != "col-123" {
		t.Fatalf("expected collection %q, got %q", "col-123", seenBody.Collection)
	}
}

func TestRunInference_DelegationUsesNonRAGPath(t *testing.T) {
	var seenPath string
	var seenBody ChatCompletionRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &seenBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","model":"test","choices":[{"index":0,"message":{"role":"assistant","content":"reasoned"}}]}`))
	}))
	defer server.Close()

	client := NewMemoryClient(server.URL, "key", server.Client())
	client.mu.Lock()
	client.collectionID = "col-123"
	client.mu.Unlock()

	agent := NewAgent(server.URL, "key", server.Client(), nil, nil)
	agent.memoryClient = client

	_, err := agent.runInferenceWithModel(context.Background(), Reasoning, []ChatMessage{
		{Role: "system", Content: "think"},
		{Role: "user", Content: "why?"},
	}, nil, reasoningMaxTokens, PromptModeMinimal)
	if err != nil {
		t.Fatalf("runInferenceWithModel: %v", err)
	}
	if seenPath != "/chat/completions" {
		t.Fatalf("expected path /chat/completions, got %q", seenPath)
	}
	if seenBody.Collection != "" {
		t.Fatalf("expected no collection for minimal mode, got %q", seenBody.Collection)
	}
}
