package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSandboxSmoke is an end-to-end smoke test exercising the sandbox through
// actual Agent tool closures, simulating real agent behavior.
func TestSandboxSmoke(t *testing.T) {
	root := t.TempDir()

	// Set up filesystem fixtures.
	os.WriteFile(filepath.Join(root, "readme.txt"), []byte("hello from inside"), 0o644)
	os.MkdirAll(filepath.Join(root, "subdir"), 0o755)
	os.WriteFile(filepath.Join(root, "subdir", "nested.txt"), []byte("nested content"), 0o644)

	// Create an outside file to try to access.
	outsideDir := t.TempDir()
	os.WriteFile(filepath.Join(outsideDir, "secret.txt"), []byte("do not read"), 0o644)

	// Build agent with sandbox at root.
	cfg := &ResolvedConfig{Config: Config{Agent: AgentConfig{WorkingDirectory: root}}}
	agent := NewAgent("http://example.com", "key", nil, nil, nil, cfg)

	readFile := findTool(t, agent, "read_file")
	listFiles := findTool(t, agent, "list_files")
	editFile := findTool(t, agent, "edit_file")

	// --- read_file smoke tests ---

	t.Run("read_file/relative_inside", func(t *testing.T) {
		input, _ := json.Marshal(ReadFileInput{Path: "readme.txt"})
		out, err := readFile.Function(input)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if out != "hello from inside" {
			t.Fatalf("got %q", out)
		}
	})

	t.Run("read_file/nested_relative", func(t *testing.T) {
		input, _ := json.Marshal(ReadFileInput{Path: "subdir/nested.txt"})
		out, err := readFile.Function(input)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if out != "nested content" {
			t.Fatalf("got %q", out)
		}
	})

	t.Run("read_file/absolute_inside", func(t *testing.T) {
		input, _ := json.Marshal(ReadFileInput{Path: filepath.Join(root, "readme.txt")})
		out, err := readFile.Function(input)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if out != "hello from inside" {
			t.Fatalf("got %q", out)
		}
	})

	t.Run("read_file/dotdot_escape_rejected", func(t *testing.T) {
		input, _ := json.Marshal(ReadFileInput{Path: "../outside"})
		_, err := readFile.Function(input)
		if err == nil {
			t.Fatal("expected error")
		}
		if !strings.Contains(err.Error(), "outside sandbox") {
			t.Fatalf("expected sandbox error, got: %v", err)
		}
	})

	t.Run("read_file/absolute_outside_rejected", func(t *testing.T) {
		input, _ := json.Marshal(ReadFileInput{Path: filepath.Join(outsideDir, "secret.txt")})
		_, err := readFile.Function(input)
		if err == nil {
			t.Fatal("expected error")
		}
		if !strings.Contains(err.Error(), "outside sandbox") {
			t.Fatalf("expected sandbox error, got: %v", err)
		}
	})

	t.Run("read_file/etc_passwd_rejected", func(t *testing.T) {
		input, _ := json.Marshal(ReadFileInput{Path: "/etc/passwd"})
		_, err := readFile.Function(input)
		if err == nil {
			t.Fatal("expected error")
		}
	})

	t.Run("read_file/dotdot_within_root_allowed", func(t *testing.T) {
		input, _ := json.Marshal(ReadFileInput{Path: "subdir/../readme.txt"})
		out, err := readFile.Function(input)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if out != "hello from inside" {
			t.Fatalf("got %q", out)
		}
	})

	// --- list_files smoke tests ---

	t.Run("list_files/root_default", func(t *testing.T) {
		input, _ := json.Marshal(ListFilesInput{})
		out, err := listFiles.Function(input)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !strings.Contains(out, "readme.txt") {
			t.Fatalf("expected readme.txt in listing, got %s", out)
		}
		if !strings.Contains(out, "subdir/") {
			t.Fatalf("expected subdir/ in listing, got %s", out)
		}
	})

	t.Run("list_files/subdir", func(t *testing.T) {
		input, _ := json.Marshal(ListFilesInput{Path: "subdir"})
		out, err := listFiles.Function(input)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !strings.Contains(out, "nested.txt") {
			t.Fatalf("expected nested.txt in listing, got %s", out)
		}
	})

	t.Run("list_files/outside_rejected", func(t *testing.T) {
		input, _ := json.Marshal(ListFilesInput{Path: outsideDir})
		_, err := listFiles.Function(input)
		if err == nil {
			t.Fatal("expected error for outside path")
		}
	})

	t.Run("list_files/dotdot_escape_rejected", func(t *testing.T) {
		input, _ := json.Marshal(ListFilesInput{Path: ".."})
		_, err := listFiles.Function(input)
		if err == nil {
			t.Fatal("expected error for .. escape")
		}
	})

	// --- edit_file smoke tests ---

	t.Run("edit_file/create_inside", func(t *testing.T) {
		input, _ := json.Marshal(EditFileInput{Path: "created.txt", OldStr: "", NewStr: "new content"})
		out, err := editFile.Function(input)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !strings.Contains(out, "Successfully created") {
			t.Fatalf("expected success message, got %q", out)
		}
		data, err := os.ReadFile(filepath.Join(root, "created.txt"))
		if err != nil {
			t.Fatalf("file not created: %v", err)
		}
		if string(data) != "new content" {
			t.Fatalf("got %q", string(data))
		}
	})

	t.Run("edit_file/modify_inside", func(t *testing.T) {
		input, _ := json.Marshal(EditFileInput{Path: "readme.txt", OldStr: "hello", NewStr: "goodbye"})
		out, err := editFile.Function(input)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if out != "OK" {
			t.Fatalf("expected OK, got %q", out)
		}
		data, _ := os.ReadFile(filepath.Join(root, "readme.txt"))
		if !strings.Contains(string(data), "goodbye") {
			t.Fatalf("edit not applied: %q", string(data))
		}
	})

	t.Run("edit_file/create_in_new_subdir", func(t *testing.T) {
		input, _ := json.Marshal(EditFileInput{Path: "newdir/deep.txt", OldStr: "", NewStr: "deep"})
		out, err := editFile.Function(input)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !strings.Contains(out, "Successfully created") {
			t.Fatalf("expected success, got %q", out)
		}
		data, _ := os.ReadFile(filepath.Join(root, "newdir", "deep.txt"))
		if string(data) != "deep" {
			t.Fatalf("got %q", string(data))
		}
	})

	t.Run("edit_file/create_outside_rejected", func(t *testing.T) {
		input, _ := json.Marshal(EditFileInput{Path: filepath.Join(outsideDir, "evil.txt"), OldStr: "", NewStr: "nope"})
		_, err := editFile.Function(input)
		if err == nil {
			t.Fatal("expected error for outside path")
		}
		// Verify file was NOT created.
		if _, err := os.Stat(filepath.Join(outsideDir, "evil.txt")); err == nil {
			t.Fatal("file should not have been created outside sandbox")
		}
	})

	t.Run("edit_file/dotdot_escape_rejected", func(t *testing.T) {
		input, _ := json.Marshal(EditFileInput{Path: "../../etc/evil", OldStr: "", NewStr: "nope"})
		_, err := editFile.Function(input)
		if err == nil {
			t.Fatal("expected error for dot-dot escape")
		}
	})

	// --- Symlink escape ---

	t.Run("symlink_escape_rejected", func(t *testing.T) {
		link := filepath.Join(root, "escape-link")
		os.Symlink(outsideDir, link)
		defer os.Remove(link)

		// read_file through symlink
		input, _ := json.Marshal(ReadFileInput{Path: "escape-link/secret.txt"})
		_, err := readFile.Function(input)
		if err == nil {
			t.Fatal("expected error for symlink escape via read_file")
		}

		// list_files through symlink
		input, _ = json.Marshal(ListFilesInput{Path: "escape-link"})
		_, err = listFiles.Function(input)
		if err == nil {
			t.Fatal("expected error for symlink escape via list_files")
		}
	})

	// --- Symlink within sandbox (should be allowed) ---

	t.Run("symlink_within_sandbox_allowed", func(t *testing.T) {
		// Symlink from inside sandbox to another file inside sandbox.
		link := filepath.Join(root, "internal-link")
		os.Symlink(filepath.Join(root, "subdir", "nested.txt"), link)
		defer os.Remove(link)

		input, _ := json.Marshal(ReadFileInput{Path: "internal-link"})
		out, err := readFile.Function(input)
		if err != nil {
			t.Fatalf("internal symlink should be allowed: %v", err)
		}
		if out != "nested content" {
			t.Fatalf("expected nested content via symlink, got %q", out)
		}
	})

	// --- Edit through symlink escape ---

	t.Run("edit_file/symlink_escape_rejected", func(t *testing.T) {
		link := filepath.Join(root, "edit-escape-link")
		os.Symlink(outsideDir, link)
		defer os.Remove(link)

		input, _ := json.Marshal(EditFileInput{Path: "edit-escape-link/evil.txt", OldStr: "", NewStr: "nope"})
		_, err := editFile.Function(input)
		if err == nil {
			t.Fatal("expected error for edit through symlink escape")
		}
		// Verify nothing was created outside.
		if _, serr := os.Stat(filepath.Join(outsideDir, "evil.txt")); serr == nil {
			t.Fatal("file should not have been created via symlink escape")
		}
	})

	// --- Dot path resolves to root ---

	t.Run("list_files/dot_resolves_to_root", func(t *testing.T) {
		input, _ := json.Marshal(ListFilesInput{Path: "."})
		out, err := listFiles.Function(input)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !strings.Contains(out, "subdir/") {
			t.Fatalf("expected subdir/ in dot listing, got %s", out)
		}
	})

	// --- Deeply nested .. escape in new-file path ---

	t.Run("edit_file/deeply_nested_dotdot_escape", func(t *testing.T) {
		// a/b don't exist; the ancestor walk should still catch the escape.
		input, _ := json.Marshal(EditFileInput{Path: "a/b/../../../etc/evil", OldStr: "", NewStr: "nope"})
		_, err := editFile.Function(input)
		if err == nil {
			t.Fatal("expected error for deeply nested .. escape via new-file path")
		}
	})

	// --- Trailing slashes / double slashes ---

	t.Run("read_file/trailing_slash_cleaned", func(t *testing.T) {
		// filepath.Clean handles this, but verify.
		input, _ := json.Marshal(ReadFileInput{Path: "subdir//nested.txt"})
		out, err := readFile.Function(input)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if out != "nested content" {
			t.Fatalf("got %q", out)
		}
	})

	// --- Sandbox root in system prompt ---
	t.Run("prompt_includes_working_directory", func(t *testing.T) {
		prompt := agent.promptBuilder.Build(PromptBuildContext{
			Mode:             PromptModeFull,
			ToolNames:        []string{"read_file"},
			WorkingDirectory: agent.sandbox.Root(),
		})
		if !strings.Contains(prompt, "Working directory: "+root) {
			t.Fatalf("expected working directory in prompt, got: %s", prompt)
		}
	})
}

func TestNewSandboxErrors(t *testing.T) {
	t.Run("non_existent_root", func(t *testing.T) {
		_, err := NewSandbox("/nonexistent/path/that/should/not/exist")
		if err == nil {
			t.Fatal("expected error for non-existent root")
		}
	})

	t.Run("file_not_directory", func(t *testing.T) {
		f := filepath.Join(t.TempDir(), "afile")
		os.WriteFile(f, []byte("x"), 0o644)
		_, err := NewSandbox(f)
		if err == nil {
			t.Fatal("expected error when root is a file, not directory")
		}
		if !strings.Contains(err.Error(), "not a directory") {
			t.Fatalf("expected 'not a directory' error, got: %v", err)
		}
	})
}

// TestSandboxFullDispatch exercises the sandbox through executeTool — the same
// code path a real model response takes. This catches bugs in tool lookup,
// JSON arg parsing, and error formatting that direct closure calls skip.
func TestSandboxFullDispatch(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "file.txt"), []byte("contents"), 0o644)
	os.MkdirAll(filepath.Join(root, "sub"), 0o755)

	cfg := &ResolvedConfig{Config: Config{Agent: AgentConfig{WorkingDirectory: root}}}
	agent := NewAgent("http://example.com", "key", nil, nil, nil, cfg)

	dispatch := func(tool, args string) ChatMessage {
		return agent.executeTool(nil, ChatToolCall{
			ID:   "test",
			Type: "function",
			Function: ChatToolCallFunction{
				Name:      tool,
				Arguments: args,
			},
		})
	}

	t.Run("list_files_via_dispatch", func(t *testing.T) {
		msg := dispatch("list_files", `{}`)
		content, _ := msg.Content.(string)
		if !strings.Contains(content, "file.txt") {
			t.Fatalf("expected file.txt in listing, got %q", content)
		}
	})

	t.Run("read_file_via_dispatch", func(t *testing.T) {
		msg := dispatch("read_file", `{"path":"file.txt"}`)
		content, _ := msg.Content.(string)
		if content != "contents" {
			t.Fatalf("expected 'contents', got %q", content)
		}
	})

	t.Run("read_file_escape_via_dispatch", func(t *testing.T) {
		msg := dispatch("read_file", `{"path":"../../etc/passwd"}`)
		content, _ := msg.Content.(string)
		if !strings.Contains(content, "outside sandbox") {
			t.Fatalf("expected sandbox error in tool result, got %q", content)
		}
	})

	t.Run("edit_file_create_via_dispatch", func(t *testing.T) {
		msg := dispatch("edit_file", `{"path":"created.txt","old_str":"","new_str":"hello"}`)
		content, _ := msg.Content.(string)
		if !strings.Contains(content, "Successfully created") {
			t.Fatalf("expected success, got %q", content)
		}
		data, _ := os.ReadFile(filepath.Join(root, "created.txt"))
		if string(data) != "hello" {
			t.Fatalf("file content: %q", string(data))
		}
	})

	t.Run("edit_file_escape_via_dispatch", func(t *testing.T) {
		msg := dispatch("edit_file", `{"path":"/etc/evil","old_str":"","new_str":"nope"}`)
		content, _ := msg.Content.(string)
		if !strings.Contains(content, "outside sandbox") {
			t.Fatalf("expected sandbox error, got %q", content)
		}
	})

	t.Run("list_files_escape_via_dispatch", func(t *testing.T) {
		msg := dispatch("list_files", `{"path":"/etc"}`)
		content, _ := msg.Content.(string)
		if !strings.Contains(content, "outside sandbox") {
			t.Fatalf("expected sandbox error, got %q", content)
		}
	})

	t.Run("dispatch_malformed_json", func(t *testing.T) {
		msg := dispatch("read_file", `{bad json}`)
		content, _ := msg.Content.(string)
		if content == "" {
			t.Fatal("expected error for malformed JSON")
		}
		// Should get a parse error, not a panic.
		if strings.Contains(content, "panic") {
			t.Fatalf("unexpected panic: %q", content)
		}
	})

	t.Run("dispatch_empty_args", func(t *testing.T) {
		// list_files with empty args should default to sandbox root.
		msg := dispatch("list_files", ``)
		content, _ := msg.Content.(string)
		if !strings.Contains(content, "file.txt") {
			t.Fatalf("expected root listing for empty args, got %q", content)
		}
	})
}

func TestSandboxRootPrefixCollision(t *testing.T) {
	// Sandbox at /tmp/XXX/sandbox, verify /tmp/XXX/sandboxescape is rejected.
	parent := t.TempDir()
	sandboxRoot := filepath.Join(parent, "sandbox")
	collisionDir := filepath.Join(parent, "sandboxescape")
	os.MkdirAll(sandboxRoot, 0o755)
	os.MkdirAll(collisionDir, 0o755)
	os.WriteFile(filepath.Join(collisionDir, "secret.txt"), []byte("gotcha"), 0o644)

	sb, err := NewSandbox(sandboxRoot)
	if err != nil {
		t.Fatalf("NewSandbox: %v", err)
	}

	// Absolute path to the collision dir should be rejected.
	_, err = sb.Resolve(filepath.Join(collisionDir, "secret.txt"))
	if err == nil {
		t.Fatal("expected error: prefix collision should not grant access")
	}
	if !strings.Contains(err.Error(), "outside sandbox") {
		t.Fatalf("expected sandbox error, got: %v", err)
	}
}
