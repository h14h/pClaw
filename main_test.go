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
}

func TestRunInferenceStream_UsesStreamAndEmitsText(t *testing.T) {
	var seenModel string
	var seenStream bool
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
	updatedConversation, response, err := agent.HandleUserMessage(context.Background(), nil, "test")
	if err != nil {
		t.Fatalf("HandleUserMessage: %v", err)
	}
	if response != "done" {
		t.Fatalf("expected final response %q, got %q", "done", response)
	}
	if len(updatedConversation) != 4 {
		t.Fatalf("expected 4 messages in conversation, got %d", len(updatedConversation))
	}
}
