package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

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
	agent := NewAgent("http://example.com", "key", "model", nil, nil, nil)
	msg := agent.executeTool(ChatToolCall{
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

	agent := NewAgent("http://example.com", "key", "model", nil, nil, []ToolDefinition{echoTool})
	args, err := json.Marshal(map[string]string{"value": "ok"})
	if err != nil {
		t.Fatalf("marshal args: %v", err)
	}

	msg := agent.executeTool(ChatToolCall{
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
