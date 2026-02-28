package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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
	agent := NewAgent("http://example.com", "key", nil, nil, nil, nil)
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

	agent := NewAgent("http://example.com", "key", nil, nil, []ToolDefinition{echoTool}, nil)
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

	agent := NewAgent("http://example.com", "key", nil, nil, []ToolDefinition{echoTool}, nil)
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
	agent := NewAgent("http://example.com", "key", nil, nil, nil, nil)
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
	event := ServerEvent{
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
	}

	t.Run("line mode emits only event and key fields", func(t *testing.T) {
		buf := &bytes.Buffer{}
		sink := &LineServerEventSink{out: buf}
		sink.HandleServerEvent(context.Background(), event)

		out := strings.TrimSpace(buf.String())
		for _, expected := range []string{
			"2026-02-21T20:22:10.104Z INFO",
			"event=tool_call.succeeded",
			"tool=read_file",
		} {
			if !strings.Contains(out, expected) {
				t.Fatalf("expected %q in output, got %q", expected, out)
			}
		}
		for _, absent := range []string{
			"trace=",
			"turn=",
			"session=",
			"msg=",
			"source=",
			"channel=",
			"user=",
			"duration_ms=",
		} {
			if strings.Contains(out, absent) {
				t.Fatalf("line mode should not contain %q, got %q", absent, out)
			}
		}
	})

	t.Run("verbose mode emits all fields", func(t *testing.T) {
		buf := &bytes.Buffer{}
		sink := &LineServerEventSink{out: buf, verboseContent: true}
		sink.HandleServerEvent(context.Background(), event)

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
	})

	t.Run("line mode includes error field on failures", func(t *testing.T) {
		buf := &bytes.Buffer{}
		sink := &LineServerEventSink{out: buf}
		sink.HandleServerEvent(context.Background(), ServerEvent{
			TS:    time.Date(2026, 2, 21, 20, 22, 10, 104000000, time.UTC),
			Level: ServerLogLevelError,
			Event: "llm.request.failed",
			Fields: map[string]interface{}{
				"error": "connection refused",
			},
		})

		out := strings.TrimSpace(buf.String())
		if !strings.Contains(out, "event=llm.request.failed") {
			t.Fatalf("expected event name in output, got %q", out)
		}
		if !strings.Contains(out, "error=\"connection refused\"") {
			t.Fatalf("expected error field in output, got %q", out)
		}
	})
}

func TestEmitToolEventAlsoEmitsServerEvent(t *testing.T) {
	agent := NewAgent("http://example.com", "key", nil, nil, nil, nil)
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
	agent := NewAgent("http://example.com", "key", nil, nil, nil, nil)
	if agent.toolEventSink != nil {
		t.Fatalf("expected nil default toolEventSink, got %T", agent.toolEventSink)
	}
}

func TestNewAgentDefaults(t *testing.T) {
	agent := NewAgent("http://example.com", "key", nil, nil, nil, nil)

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

	agent := NewAgent(server.URL, "key", server.Client(), nil, nil, nil)
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

	agent := NewAgent(server.URL, "key", server.Client(), nil, nil, nil)
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

	agent := NewAgent(server.URL, "key", server.Client(), nil, nil, nil)
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

	agent := NewAgent(server.URL, "key", server.Client(), nil, nil, nil)
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
	agent := NewAgent("http://example.com", "key", nil, nil, nil, nil)
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

	agent := NewAgent(server.URL, "key", server.Client(), nil, []ToolDefinition{echoTool}, nil)
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
	agent := NewAgent(server.URL, "key", server.Client(), nil, []ToolDefinition{echoTool}, nil)
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

func TestExecuteToolAsync_ReturnsSyntheticResult(t *testing.T) {
	executed := make(chan struct{}, 1)
	slowTool := ToolDefinition{
		Name:        "slow_async",
		Description: "Async tool that sleeps briefly.",
		InputSchema: map[string]interface{}{"type": "object"},
		Async:       true,
		Function: func(input json.RawMessage) (string, error) {
			time.Sleep(50 * time.Millisecond)
			executed <- struct{}{}
			return "done", nil
		},
	}

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
			_, _ = w.Write([]byte(`{"id":"x","model":"kimi-k2-instruct","choices":[{"index":0,"message":{"role":"assistant","tool_calls":[{"id":"call_async_1","type":"function","function":{"name":"slow_async","arguments":"{}"}}]}}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"x","model":"kimi-k2-instruct","choices":[{"index":0,"message":{"role":"assistant","content":"all done"}}]}`))
	}))
	defer server.Close()

	agent := NewAgent(server.URL, "key", server.Client(), nil, []ToolDefinition{slowTool}, nil)
	updatedCS, response, err := agent.HandleUserMessage(context.Background(), NewConversationState(), "test")
	if err != nil {
		t.Fatalf("HandleUserMessage: %v", err)
	}
	if response != "all done" {
		t.Fatalf("expected response %q, got %q", "all done", response)
	}

	// The tool result in conversation state should be the synthetic "Accepted." message.
	var toolResultContent string
	for _, msg := range updatedCS.Messages {
		if msg.Role == "tool" {
			if s, ok := msg.Content.(string); ok {
				toolResultContent = s
			}
			break
		}
	}
	if toolResultContent != "Accepted." {
		t.Fatalf("expected synthetic result %q, got %q", "Accepted.", toolResultContent)
	}

	// Wait for the async goroutine to complete and verify it did execute.
	agent.WaitForAsync()
	select {
	case <-executed:
		// success — function ran
	default:
		t.Fatal("async function did not execute")
	}
}

func TestExecuteToolSync_UnchangedBehavior(t *testing.T) {
	echoTool := ToolDefinition{
		Name:        "echo",
		Description: "Echo input.",
		InputSchema: map[string]interface{}{"type": "object"},
		Async:       false,
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
			_, _ = w.Write([]byte(`{"id":"x","model":"kimi-k2-instruct","choices":[{"index":0,"message":{"role":"assistant","tool_calls":[{"id":"call_sync_1","type":"function","function":{"name":"echo","arguments":"{\"value\":\"hello\"}"}}]}}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"x","model":"kimi-k2-instruct","choices":[{"index":0,"message":{"role":"assistant","content":"done"}}]}`))
	}))
	defer server.Close()

	agent := NewAgent(server.URL, "key", server.Client(), nil, []ToolDefinition{echoTool}, nil)
	updatedCS, response, err := agent.HandleUserMessage(context.Background(), NewConversationState(), "test")
	if err != nil {
		t.Fatalf("HandleUserMessage: %v", err)
	}
	if response != "done" {
		t.Fatalf("expected final response %q, got %q", "done", response)
	}

	// The tool result should contain the actual function output, not "Accepted."
	var toolResultContent string
	for _, msg := range updatedCS.Messages {
		if msg.Role == "tool" {
			if s, ok := msg.Content.(string); ok {
				toolResultContent = s
			}
			break
		}
	}
	if toolResultContent != "hello" {
		t.Fatalf("expected tool result %q, got %q", "hello", toolResultContent)
	}
	if len(updatedCS.Messages) != 4 {
		t.Fatalf("expected 4 messages in conversation, got %d", len(updatedCS.Messages))
	}
}

func TestExecuteToolAsync_ErrorNonFatal(t *testing.T) {
	errorTool := ToolDefinition{
		Name:        "failing_async",
		Description: "Async tool that always errors.",
		InputSchema: map[string]interface{}{"type": "object"},
		Async:       true,
		Function: func(input json.RawMessage) (string, error) {
			return "", fmt.Errorf("something went wrong")
		},
	}

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
			_, _ = w.Write([]byte(`{"id":"x","model":"kimi-k2-instruct","choices":[{"index":0,"message":{"role":"assistant","tool_calls":[{"id":"call_err_1","type":"function","function":{"name":"failing_async","arguments":"{}"}}]}}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"x","model":"kimi-k2-instruct","choices":[{"index":0,"message":{"role":"assistant","content":"carried on"}}]}`))
	}))
	defer server.Close()

	agent := NewAgent(server.URL, "key", server.Client(), nil, []ToolDefinition{errorTool}, nil)
	sink := &capturedToolEventSink{}
	agent.toolEventSink = sink

	updatedCS, response, err := agent.HandleUserMessage(context.Background(), NewConversationState(), "test")
	if err != nil {
		t.Fatalf("HandleUserMessage: %v", err)
	}
	if response != "carried on" {
		t.Fatalf("expected response %q, got %q", "carried on", response)
	}

	// The tool result in conversation should be the synthetic "Accepted." message.
	var toolResultContent string
	for _, msg := range updatedCS.Messages {
		if msg.Role == "tool" {
			if s, ok := msg.Content.(string); ok {
				toolResultContent = s
			}
			break
		}
	}
	if toolResultContent != "Accepted." {
		t.Fatalf("expected synthetic result %q, got %q", "Accepted.", toolResultContent)
	}

	// Wait for the async goroutine to complete, then check that a ToolEventFailed was emitted.
	agent.WaitForAsync()
	hasFailed := false
	for _, evt := range sink.events {
		if evt.Type == ToolEventFailed && evt.ToolName == "failing_async" {
			hasFailed = true
			break
		}
	}
	if !hasFailed {
		t.Fatal("expected ToolEventFailed for async tool error")
	}
}

func TestInjectThinkingToggle_NoKeypath(t *testing.T) {
	agent := NewAgent("http://example.com", "key", nil, nil, nil, nil)
	body := []byte(`{"model":"test","messages":[]}`)
	out, err := agent.injectThinkingToggle(body, true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !bytes.Equal(body, out) {
		t.Fatalf("expected unchanged body when no keypath set, got %s", out)
	}
}

func TestInjectThinkingToggle_InjectsNestedField(t *testing.T) {
	agent := NewAgent("http://example.com", "key", nil, nil, nil, nil)
	agent.thinkingToggleKeypath = []string{"chat_template_kwargs", "enable_thinking"}
	agent.thinkingToggleOnValue = true
	agent.thinkingToggleOffValue = false

	body := []byte(`{"model":"test","messages":[]}`)

	// Test thinking=true injects on value.
	onBody, err := agent.injectThinkingToggle(body, true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var onResult map[string]interface{}
	if err := json.Unmarshal(onBody, &onResult); err != nil {
		t.Fatalf("unmarshal on body: %v", err)
	}
	kwargs, ok := onResult["chat_template_kwargs"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected chat_template_kwargs map, got %T", onResult["chat_template_kwargs"])
	}
	if kwargs["enable_thinking"] != true {
		t.Fatalf("expected enable_thinking=true, got %v", kwargs["enable_thinking"])
	}

	// Test thinking=false injects off value.
	offBody, err := agent.injectThinkingToggle(body, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var offResult map[string]interface{}
	if err := json.Unmarshal(offBody, &offResult); err != nil {
		t.Fatalf("unmarshal off body: %v", err)
	}
	kwargs, ok = offResult["chat_template_kwargs"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected chat_template_kwargs map, got %T", offResult["chat_template_kwargs"])
	}
	if kwargs["enable_thinking"] != false {
		t.Fatalf("expected enable_thinking=false, got %v", kwargs["enable_thinking"])
	}
}

func TestInjectThinkingToggle_ComplexValue(t *testing.T) {
	agent := NewAgent("http://example.com", "key", nil, nil, nil, nil)
	agent.thinkingToggleKeypath = []string{"chat_template_kwargs"}
	agent.thinkingToggleOnValue = map[string]interface{}{"enable_thinking": true}
	agent.thinkingToggleOffValue = map[string]interface{}{"enable_thinking": false}

	body := []byte(`{"model":"test"}`)
	out, err := agent.injectThinkingToggle(body, true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var result map[string]interface{}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	kwargs, ok := result["chat_template_kwargs"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected chat_template_kwargs map, got %T", result["chat_template_kwargs"])
	}
	if kwargs["enable_thinking"] != true {
		t.Fatalf("expected enable_thinking=true, got %v", kwargs["enable_thinking"])
	}
}

func TestDelegateReasoningUsesReasoningContent(t *testing.T) {
	// GLM returns thinking as reasoning_content, not reasoning.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"","reasoning_content":"the reasoning output"}}]}`))
	}))
	defer server.Close()

	agent := NewAgent(server.URL, "key", server.Client(), nil, nil, nil)
	out, err := agent.delegateReasoning(json.RawMessage(`{"question":"why"}`))
	if err != nil {
		t.Fatalf("delegateReasoning: %v", err)
	}
	if out != "the reasoning output" {
		t.Fatalf("expected reasoning_content output, got %q", out)
	}
}

func TestOptionalAPIKey_NoAuthHeader(t *testing.T) {
	var sawAuth bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			sawAuth = true
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer server.Close()

	agent := NewAgent(server.URL, "", server.Client(), nil, nil, nil)
	_, err := agent.runInference(context.Background(), []ChatMessage{{Role: "user", Content: "hi"}})
	if err != nil {
		t.Fatalf("runInference: %v", err)
	}
	if sawAuth {
		t.Fatal("expected no Authorization header when API key is empty")
	}
}

func TestOptionalAPIKey_SetsAuthHeader(t *testing.T) {
	var sawAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer server.Close()

	agent := NewAgent(server.URL, "test-key", server.Client(), nil, nil, nil)
	_, err := agent.runInference(context.Background(), []ChatMessage{{Role: "user", Content: "hi"}})
	if err != nil {
		t.Fatalf("runInference: %v", err)
	}
	if sawAuth != "Bearer test-key" {
		t.Fatalf("expected Authorization header 'Bearer test-key', got %q", sawAuth)
	}
}

func TestStreamReasoningContent(t *testing.T) {
	// Verify streaming accumulates reasoning_content deltas.
	agent := NewAgent("http://example.com", "key", nil, nil, nil, nil)
	message := ChatMessage{Role: "assistant"}
	var contentBuilder strings.Builder
	var reasoningBuilder strings.Builder
	toolCallsByIndex := map[int]*ChatToolCall{}
	toolCallOrder := []int{}

	// Simulate a stream event with reasoning_content.
	payload := `{"id":"x","model":"m","choices":[{"index":0,"delta":{"reasoning_content":"thinking..."}}]}`
	err := agent.processStreamEvent(payload, &message, &contentBuilder, &reasoningBuilder, toolCallsByIndex, &toolCallOrder, nil)
	if err != nil {
		t.Fatalf("processStreamEvent: %v", err)
	}
	if reasoningBuilder.String() != "thinking..." {
		t.Fatalf("expected reasoning_content accumulated, got %q", reasoningBuilder.String())
	}
}

func TestSandboxResolveRelative(t *testing.T) {
	root := t.TempDir()
	sb, err := NewSandbox(root)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	// Create subdir so the parent exists for resolution.
	if err := os.MkdirAll(filepath.Join(root, "subdir"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	resolved, err := sb.Resolve("subdir/file.txt")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	expected := filepath.Join(root, "subdir", "file.txt")
	if resolved != expected {
		t.Fatalf("expected %q, got %q", expected, resolved)
	}
}

func TestSandboxResolveAbsoluteInside(t *testing.T) {
	root := t.TempDir()
	sb, err := NewSandbox(root)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	// Create a file inside root.
	inside := filepath.Join(root, "inside.txt")
	if err := os.WriteFile(inside, []byte("hi"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	resolved, err := sb.Resolve(inside)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if resolved != inside {
		t.Fatalf("expected %q, got %q", inside, resolved)
	}
}

func TestSandboxResolveAbsoluteOutside(t *testing.T) {
	root := t.TempDir()
	sb, err := NewSandbox(root)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	_, err = sb.Resolve("/etc/passwd")
	if err == nil {
		t.Fatal("expected error for absolute path outside sandbox")
	}
}

func TestSandboxResolveDotDotEscape(t *testing.T) {
	root := t.TempDir()
	sb, err := NewSandbox(root)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	_, err = sb.Resolve("../../etc/passwd")
	if err == nil {
		t.Fatal("expected error for dot-dot escape")
	}
}

func TestSandboxResolveDotDotWithinRoot(t *testing.T) {
	root := t.TempDir()
	sb, err := NewSandbox(root)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	// Create subdir and file.
	if err := os.MkdirAll(filepath.Join(root, "subdir"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	target := filepath.Join(root, "file.txt")
	if err := os.WriteFile(target, []byte("hi"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	resolved, err := sb.Resolve("subdir/../file.txt")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if resolved != target {
		t.Fatalf("expected %q, got %q", target, resolved)
	}
}

func TestSandboxResolveSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	sb, err := NewSandbox(root)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	// Create a symlink inside root that points outside.
	link := filepath.Join(root, "escape")
	if err := os.Symlink("/tmp", link); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	_, err = sb.Resolve("escape")
	if err == nil {
		t.Fatal("expected error for symlink escape")
	}
}

func TestSandboxResolveEmpty(t *testing.T) {
	root := t.TempDir()
	sb, err := NewSandbox(root)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	resolved, err := sb.Resolve("")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if resolved != root {
		t.Fatalf("expected root %q, got %q", root, resolved)
	}
}

func TestSandboxResolveNewFileValidParent(t *testing.T) {
	root := t.TempDir()
	sb, err := NewSandbox(root)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}
	// newfile.txt doesn't exist, but parent (root) does.
	resolved, err := sb.Resolve("newfile.txt")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	expected := filepath.Join(root, "newfile.txt")
	if resolved != expected {
		t.Fatalf("expected %q, got %q", expected, resolved)
	}
}

func TestSandboxDefaultXDG(t *testing.T) {
	// Use a temp dir as XDG_DATA_HOME so we don't touch real filesystem.
	tmpXDG := t.TempDir()
	t.Setenv("XDG_DATA_HOME", tmpXDG)

	sb, err := NewSandbox("")
	if err != nil {
		t.Fatalf("NewSandbox with default: %v", err)
	}
	expected := filepath.Join(tmpXDG, "pclaw", "workspace")
	if sb.Root() != expected {
		t.Fatalf("expected root %q, got %q", expected, sb.Root())
	}
	// Directory should have been created.
	info, err := os.Stat(expected)
	if err != nil {
		t.Fatalf("expected directory to exist: %v", err)
	}
	if !info.IsDir() {
		t.Fatalf("expected a directory at %s", expected)
	}
}

// newSandboxedAgent creates an Agent with a sandbox rooted at the given directory.
func newSandboxedAgent(t *testing.T, root string) *Agent {
	t.Helper()
	cfg := &ResolvedConfig{
		Config: Config{
			Agent: AgentConfig{WorkingDirectory: root},
		},
	}
	return NewAgent("http://example.com", "key", nil, nil, nil, cfg)
}

// findTool returns the tool with the given name from the agent.
func findTool(t *testing.T, agent *Agent, name string) ToolDefinition {
	t.Helper()
	for _, tool := range agent.tools {
		if tool.Name == name {
			return tool
		}
	}
	t.Fatalf("tool %q not found", name)
	return ToolDefinition{}
}

func TestSandboxedReadFile(t *testing.T) {
	root := t.TempDir()
	agent := newSandboxedAgent(t, root)
	readFile := findTool(t, agent, "read_file")

	// Write a file inside the sandbox.
	inside := filepath.Join(root, "hello.txt")
	if err := os.WriteFile(inside, []byte("world"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	// Reading a relative path inside sandbox should succeed.
	input, _ := json.Marshal(ReadFileInput{Path: "hello.txt"})
	out, err := readFile.Function(input)
	if err != nil {
		t.Fatalf("read inside sandbox: %v", err)
	}
	if out != "world" {
		t.Fatalf("expected %q, got %q", "world", out)
	}

	// Reading an absolute path outside sandbox should fail.
	input, _ = json.Marshal(ReadFileInput{Path: "/etc/hostname"})
	_, err = readFile.Function(input)
	if err == nil {
		t.Fatal("expected error for path outside sandbox")
	}

	// Reading a dot-dot escape should fail.
	input, _ = json.Marshal(ReadFileInput{Path: "../../etc/passwd"})
	_, err = readFile.Function(input)
	if err == nil {
		t.Fatal("expected error for dot-dot escape")
	}
}

func TestSandboxedListFiles(t *testing.T) {
	root := t.TempDir()
	agent := newSandboxedAgent(t, root)
	listFiles := findTool(t, agent, "list_files")

	// Create files and dirs inside sandbox.
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("a"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.Mkdir(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	// Listing with empty path should list sandbox root.
	input, _ := json.Marshal(ListFilesInput{})
	out, err := listFiles.Function(input)
	if err != nil {
		t.Fatalf("list sandbox root: %v", err)
	}
	var files []string
	if err := json.Unmarshal([]byte(out), &files); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(files) != 2 {
		t.Fatalf("expected 2 entries, got %d: %v", len(files), files)
	}

	// Listing an absolute path outside sandbox should fail.
	input, _ = json.Marshal(ListFilesInput{Path: "/tmp"})
	_, err = listFiles.Function(input)
	if err == nil {
		t.Fatal("expected error for path outside sandbox")
	}
}

func TestSandboxedEditFile(t *testing.T) {
	root := t.TempDir()
	agent := newSandboxedAgent(t, root)
	editFile := findTool(t, agent, "edit_file")

	// Edit (create) a new file inside sandbox.
	input, _ := json.Marshal(EditFileInput{
		Path:   "new.txt",
		OldStr: "",
		NewStr: "created",
	})
	out, err := editFile.Function(input)
	if err != nil {
		t.Fatalf("create inside sandbox: %v", err)
	}
	if out == "" {
		t.Fatal("expected non-empty result for file creation")
	}
	content, err := os.ReadFile(filepath.Join(root, "new.txt"))
	if err != nil {
		t.Fatalf("read created file: %v", err)
	}
	if string(content) != "created" {
		t.Fatalf("expected %q, got %q", "created", string(content))
	}

	// Edit an existing file inside sandbox.
	input, _ = json.Marshal(EditFileInput{
		Path:   "new.txt",
		OldStr: "created",
		NewStr: "modified",
	})
	out, err = editFile.Function(input)
	if err != nil {
		t.Fatalf("edit inside sandbox: %v", err)
	}
	if out != "OK" {
		t.Fatalf("expected %q, got %q", "OK", out)
	}
	content, err = os.ReadFile(filepath.Join(root, "new.txt"))
	if err != nil {
		t.Fatalf("read edited file: %v", err)
	}
	if string(content) != "modified" {
		t.Fatalf("expected %q, got %q", "modified", string(content))
	}

	// Creating a file outside sandbox should fail.
	input, _ = json.Marshal(EditFileInput{
		Path:   "/tmp/escape.txt",
		OldStr: "",
		NewStr: "nope",
	})
	_, err = editFile.Function(input)
	if err == nil {
		t.Fatal("expected error for path outside sandbox")
	}
}
