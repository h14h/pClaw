package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSectionedPromptBuilderFullIncludesCoreSections(t *testing.T) {
	builder := NewSectionedPromptBuilder(DefaultPromptConfig())
	prompt := builder.Build(PromptBuildContext{
		Mode:      PromptModeFull,
		Transport: "cli",
		ToolNames: []string{"read_file", "edit_file"},
	})

	for _, section := range []string{"[Identity]", "[Behavior]", "[Tooling]", "[Safety]", "[Runtime]"} {
		if !strings.Contains(prompt, section) {
			t.Fatalf("expected section %s in prompt, got: %s", section, prompt)
		}
	}
	if !strings.Contains(prompt, "read_file") {
		t.Fatalf("expected tool name in prompt, got: %s", prompt)
	}
	if !strings.Contains(prompt, "<<MSG_SPLIT>>") {
		t.Fatalf("expected runtime split marker instruction in prompt, got: %s", prompt)
	}
}

func TestSectionedPromptBuilderMinimalOmitsIdentityAndTooling(t *testing.T) {
	builder := NewSectionedPromptBuilder(DefaultPromptConfig())
	prompt := builder.Build(PromptBuildContext{Mode: PromptModeMinimal})

	if strings.Contains(prompt, "[Identity]") {
		t.Fatalf("did not expect Identity section in minimal mode, got: %s", prompt)
	}
	if strings.Contains(prompt, "[Tooling]") {
		t.Fatalf("did not expect Tooling section in minimal mode, got: %s", prompt)
	}
}

func TestSectionedPromptBuilderTruncatesPersona(t *testing.T) {
	cfg := DefaultPromptConfig()
	cfg.Persona = strings.Repeat("x", 20)
	cfg.MaxPersonaChars = 5
	builder := NewSectionedPromptBuilder(cfg)

	prompt := builder.Build(PromptBuildContext{Mode: PromptModeFull})
	if !strings.Contains(prompt, "Persona: xxxxx") {
		t.Fatalf("expected truncated persona, got: %s", prompt)
	}
}

func TestPromptBuildContextWorkingDirectory(t *testing.T) {
	builder := NewSectionedPromptBuilder(DefaultPromptConfig())
	prompt := builder.Build(PromptBuildContext{
		Mode:             PromptModeFull,
		Transport:        "cli",
		ToolNames:        []string{"read_file"},
		WorkingDirectory: "/tmp/test-sandbox",
	})
	if !strings.Contains(prompt, "Working directory: /tmp/test-sandbox") {
		t.Fatalf("expected working directory in prompt, got: %s", prompt)
	}
}

func TestPromptBuildContextWorkingDirectoryOmittedWhenEmpty(t *testing.T) {
	builder := NewSectionedPromptBuilder(DefaultPromptConfig())
	prompt := builder.Build(PromptBuildContext{
		Mode:      PromptModeFull,
		Transport: "cli",
		ToolNames: []string{"read_file"},
	})
	if strings.Contains(prompt, "Working directory:") {
		t.Fatalf("did not expect working directory in prompt when empty, got: %s", prompt)
	}
}

func TestPrependSystemPromptEnsuresSingleLeadingSystemMessage(t *testing.T) {
	conversation := []ChatMessage{
		{Role: "system", Content: "old"},
		{Role: "user", Content: "hi"},
	}
	out := prependSystemPrompt(conversation, "new")

	if len(out) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(out))
	}
	if out[0].Role != "system" || out[0].Content != "new" {
		t.Fatalf("unexpected first message: %#v", out[0])
	}
	if out[1].Role != "user" {
		t.Fatalf("expected user as second message, got: %#v", out[1])
	}
}

func TestPromptConfigFromCfgExpandsTildeInPersonaFile(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("cannot determine home directory")
	}

	// Create a temp persona file under the home directory.
	tmpDir := filepath.Join(home, ".pclaw-test-"+t.Name())
	os.MkdirAll(tmpDir, 0o755)
	defer os.RemoveAll(tmpDir)

	personaFile := filepath.Join(tmpDir, "persona.md")
	os.WriteFile(personaFile, []byte("I am a test persona"), 0o644)

	// Build a tilde-prefixed path: ~/.pclaw-test-<name>/persona.md
	rel, _ := filepath.Rel(home, personaFile)
	tildePath := "~/" + rel

	rcfg := &ResolvedConfig{Config: Config{Agent: AgentConfig{PersonaFile: tildePath}}}
	cfg := promptConfigFromCfg(rcfg)

	if cfg.Persona != "I am a test persona" {
		t.Fatalf("expected persona from tilde path, got: %q", cfg.Persona)
	}
}
