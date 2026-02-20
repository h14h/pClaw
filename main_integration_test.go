package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
)

func requireRealVultrConfig(t *testing.T) (string, string, string) {
	t.Helper()

	apiKey := os.Getenv("VULTR_API_KEY")
	if apiKey == "" {
		t.Skip("set VULTR_API_KEY to run real Vultr integration tests")
	}

	baseURL := os.Getenv("VULTR_BASE_URL")
	if baseURL == "" {
		baseURL = defaultVultrBaseURL
	}
	model := os.Getenv("VULTR_MODEL")
	if model == "" {
		model = defaultVultrModel
	}

	return strings.TrimRight(baseURL, "/"), apiKey, model
}

func TestRunInference_E2E_TextResponse(t *testing.T) {
	baseURL, apiKey, model := requireRealVultrConfig(t)

	agent := NewAgent(baseURL, apiKey, model, http.DefaultClient, nil, nil)
	msg, err := agent.runInference(context.Background(), []ChatMessage{{
		Role:    "user",
		Content: "Reply with exactly: OK",
	}})
	if err != nil {
		t.Fatalf("runInference failed: %v", err)
	}

	text, ok := msg.Content.(string)
	if !ok {
		t.Fatalf("expected string content, got %T", msg.Content)
	}
	if strings.TrimSpace(text) == "" {
		t.Fatal("expected non-empty text response")
	}
}

func TestRunInference_E2E_ToolCall(t *testing.T) {
	baseURL, apiKey, model := requireRealVultrConfig(t)

	echoTool := ToolDefinition{
		Name:        "echo",
		Description: "Echoes the provided value.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"value": map[string]interface{}{"type": "string"},
			},
			"required": []string{"value"},
		},
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

	agent := NewAgent(baseURL, apiKey, model, http.DefaultClient, nil, []ToolDefinition{echoTool})
	msg, err := agent.runInference(context.Background(), []ChatMessage{{
		Role:    "user",
		Content: "Use the echo tool with value set to 'vultr-test'.",
	}})
	if err != nil {
		t.Fatalf("runInference failed: %v", err)
	}

	if len(msg.ToolCalls) == 0 {
		t.Fatalf("expected at least one tool call, got message content=%v", msg.Content)
	}

	result := agent.executeTool(msg.ToolCalls[0])
	if result.Role != "tool" {
		t.Fatalf("expected tool role result, got %q", result.Role)
	}
	resultText, ok := result.Content.(string)
	if !ok {
		t.Fatalf("expected tool result content string, got %T", result.Content)
	}
	if strings.TrimSpace(resultText) == "" {
		t.Fatal("expected non-empty tool result")
	}

	finalMsg, err := agent.runInference(context.Background(), []ChatMessage{
		{Role: "user", Content: "Use the echo tool with value set to 'vultr-test'."},
		msg,
		result,
	})
	if err != nil {
		t.Fatalf("runInference after tool result failed: %v", err)
	}

	finalText, ok := finalMsg.Content.(string)
	if !ok {
		t.Fatalf("expected final string content, got %T", finalMsg.Content)
	}
	if strings.TrimSpace(finalText) == "" {
		t.Fatal("expected non-empty final response after tool result")
	}
}

func TestAgentRun_E2E_ReadFileTool(t *testing.T) {
	baseURL, apiKey, model := requireRealVultrConfig(t)

	dir := t.TempDir()
	originalDir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(originalDir)
	})

	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello from e2e"), 0o644); err != nil {
		t.Fatalf("write note.txt: %v", err)
	}

	var called atomic.Bool
	readTool := ReadFileDefinition
	readTool.Function = func(input json.RawMessage) (string, error) {
		called.Store(true)
		out, err := ReadFile(input)
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(out) == "" {
			return "", fmt.Errorf("read_file returned empty content")
		}
		return out, nil
	}

	prompt := "Call the read_file tool with path \"note.txt\" exactly once. After the tool result, respond with only OK and do not call any more tools."
	getUserMessage := func() func() (string, bool) {
		used := false
		return func() (string, bool) {
			if used {
				return "", false
			}
			used = true
			return prompt, true
		}
	}()

	agent := NewAgent(baseURL, apiKey, model, http.DefaultClient, getUserMessage, []ToolDefinition{
		readTool,
		ListFilesDefinition,
		EditFileDefinition,
	})
	if err := agent.Run(context.Background()); err != nil {
		t.Fatalf("agent run failed: %v", err)
	}
	if !called.Load() {
		t.Fatal("expected read_file tool to be called")
	}
}

func TestAgentRun_E2E_ListFilesTool(t *testing.T) {
	baseURL, apiKey, model := requireRealVultrConfig(t)

	dir := t.TempDir()
	originalDir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(originalDir)
	})

	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644); err != nil {
		t.Fatalf("write a.txt: %v", err)
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatalf("mkdir sub: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sub", "b.txt"), []byte("b"), 0o644); err != nil {
		t.Fatalf("write b.txt: %v", err)
	}

	var called atomic.Bool
	listTool := ListFilesDefinition
	listTool.Function = func(input json.RawMessage) (string, error) {
		called.Store(true)
		out, err := ListFiles(input)
		if err != nil {
			return "", err
		}
		var files []string
		if err := json.Unmarshal([]byte(out), &files); err != nil {
			return "", err
		}
		for _, expected := range []string{"a.txt", "sub/"} {
			if !slices.Contains(files, expected) {
				return "", fmt.Errorf("expected %q in list, got %v", expected, files)
			}
		}
		return out, nil
	}

	prompt := "Use the list_files tool with path \".\" exactly once to list the current directory. After the tool result, respond with only OK and do not call any more tools."
	getUserMessage := func() func() (string, bool) {
		used := false
		return func() (string, bool) {
			if used {
				return "", false
			}
			used = true
			return prompt, true
		}
	}()

	agent := NewAgent(baseURL, apiKey, model, http.DefaultClient, getUserMessage, []ToolDefinition{
		ReadFileDefinition,
		listTool,
		EditFileDefinition,
	})
	if err := agent.Run(context.Background()); err != nil {
		t.Fatalf("agent run failed: %v", err)
	}
	if !called.Load() {
		t.Fatal("expected list_files tool to be called")
	}
}

func TestAgentRun_E2E_EditFileTool(t *testing.T) {
	baseURL, apiKey, model := requireRealVultrConfig(t)

	dir := t.TempDir()
	originalDir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(originalDir)
	})

	var called atomic.Bool
	editTool := EditFileDefinition
	editTool.Function = func(input json.RawMessage) (string, error) {
		called.Store(true)
		return EditFile(input)
	}

	prompt := "Call the edit_file tool with path \"out.txt\", old_str \"\", new_str \"edited\". After the tool result, respond with only OK and do not call any more tools."
	getUserMessage := func() func() (string, bool) {
		used := false
		return func() (string, bool) {
			if used {
				return "", false
			}
			used = true
			return prompt, true
		}
	}()

	agent := NewAgent(baseURL, apiKey, model, http.DefaultClient, getUserMessage, []ToolDefinition{
		ReadFileDefinition,
		ListFilesDefinition,
		editTool,
	})
	if err := agent.Run(context.Background()); err != nil {
		t.Fatalf("agent run failed: %v", err)
	}
	if !called.Load() {
		t.Fatal("expected edit_file tool to be called")
	}

	edited, err := os.ReadFile(filepath.Join(dir, "out.txt"))
	if err != nil {
		t.Fatalf("read out.txt: %v", err)
	}
	if strings.TrimSpace(string(edited)) != "edited" {
		t.Fatalf("expected out.txt content %q, got %q", "edited", string(edited))
	}
}
