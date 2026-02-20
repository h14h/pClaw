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

func TestCLIToolEventSinkSummary(t *testing.T) {
	buf := &bytes.Buffer{}
	sink := &CLIToolEventSink{out: buf}

	sink.HandleToolEvent(context.Background(), ToolEvent{
		Type:     ToolEventStarted,
		ToolName: "read_file",
		ArgsRaw:  `{"path":"note.txt"}`,
		ArgsParsed: map[string]interface{}{
			"path": "note.txt",
		},
	})
	sink.HandleToolEvent(context.Background(), ToolEvent{
		Type:      ToolEventSucceeded,
		ToolName:  "list_files",
		ResultRaw: `["a.txt","sub/"]`,
		ArgsParsed: map[string]interface{}{
			"path": ".",
		},
		Duration: time.Millisecond,
	})
	sink.HandleToolEvent(context.Background(), ToolEvent{
		Type:     ToolEventFailed,
		ToolName: "reason_with_gpt_oss",
		Err:      "timeout",
	})

	out := buf.String()
	for _, expected := range []string{
		`Reading file: "note.txt"`,
		`Listed "." (2 entries: 1 files, 1 dirs) in 1ms`,
		`Reasoning failed: timeout`,
	} {
		if !strings.Contains(out, expected) {
			t.Fatalf("expected output to contain %q, got %q", expected, out)
		}
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
		if tool.Name == "reason_with_gpt_oss" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("expected reason_with_gpt_oss tool to be registered")
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

func TestReasonWithGptOssUsesReasoningModel(t *testing.T) {
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
	out, err := agent.reasonWithGptOss(json.RawMessage(`{"question":"why","context":"ctx"}`))
	if err != nil {
		t.Fatalf("reasonWithGptOss: %v", err)
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

func TestReasonWithGptOssLimit(t *testing.T) {
	agent := NewAgent("http://example.com", "key", nil, nil, nil)
	agent.reasoningCallCount = defaultReasoningLimit

	_, err := agent.reasonWithGptOss(json.RawMessage(`{"question":"why"}`))
	if err == nil {
		t.Fatal("expected limit error")
	}
	if !strings.Contains(err.Error(), "limit") {
		t.Fatalf("expected limit error message, got %v", err)
	}
}
