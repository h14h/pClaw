package main

import (
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
