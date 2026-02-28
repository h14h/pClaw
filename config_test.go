package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExpandTildeReplacesPrefix(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("cannot determine home directory")
	}
	got := expandTilde("~/foo/bar")
	want := filepath.Join(home, "foo/bar")
	if got != want {
		t.Fatalf("expandTilde(\"~/foo/bar\") = %q, want %q", got, want)
	}
}

func TestExpandTildeNoopForAbsolutePath(t *testing.T) {
	got := expandTilde("/etc/config")
	if got != "/etc/config" {
		t.Fatalf("expandTilde(\"/etc/config\") = %q, want \"/etc/config\"", got)
	}
}

func TestExpandTildeNoopForRelativePath(t *testing.T) {
	got := expandTilde("relative/path")
	if got != "relative/path" {
		t.Fatalf("expandTilde(\"relative/path\") = %q, want \"relative/path\"", got)
	}
}

func TestExpandTildeNoopForEmpty(t *testing.T) {
	got := expandTilde("")
	if got != "" {
		t.Fatalf("expandTilde(\"\") = %q, want \"\"", got)
	}
}

func TestExpandTildeNoopForBareHome(t *testing.T) {
	// "~" alone (without trailing slash) should not be expanded.
	got := expandTilde("~")
	if got != "~" {
		t.Fatalf("expandTilde(\"~\") = %q, want \"~\"", got)
	}
}

// writeTestConfig writes a TOML config to a temp file and sets PCLAW_CONFIG to point at it.
// It returns a cleanup function that restores the original env vars.
func writeTestConfig(t *testing.T, tomlContent string) {
	t.Helper()
	tmp := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(tmp, []byte(tomlContent), 0o644); err != nil {
		t.Fatalf("write temp config: %v", err)
	}
	t.Setenv("PCLAW_CONFIG", tmp)
	// Clear overrides so they don't leak between tests.
	t.Setenv("PCLAW_PROVIDER", "")
	t.Setenv("PCLAW_MODEL", "")
}

func TestLoadConfig_ActiveModelResolvesToProviderFields(t *testing.T) {
	writeTestConfig(t, `
active_provider = "local"

[providers.local]
base_url = "http://localhost:8000/v1"
active_model = "glm47"

[providers.local.models.glm47]
model_id = "glm-4.7-flash-q4km"
thinking_toggle_keypath = ["chat_template_kwargs", "enable_thinking"]
thinking_toggle_on_value = true
thinking_toggle_off_value = false
`)

	rc, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if rc.Provider.PrimaryModel != "glm-4.7-flash-q4km" {
		t.Errorf("PrimaryModel = %q, want %q", rc.Provider.PrimaryModel, "glm-4.7-flash-q4km")
	}
	if rc.Provider.ReasoningModel != "glm-4.7-flash-q4km" {
		t.Errorf("ReasoningModel = %q, want %q", rc.Provider.ReasoningModel, "glm-4.7-flash-q4km")
	}
	if rc.Provider.SummarizationModel != "glm-4.7-flash-q4km" {
		t.Errorf("SummarizationModel = %q, want %q", rc.Provider.SummarizationModel, "glm-4.7-flash-q4km")
	}
	if len(rc.Provider.ThinkingToggleKeypath) != 2 ||
		rc.Provider.ThinkingToggleKeypath[0] != "chat_template_kwargs" ||
		rc.Provider.ThinkingToggleKeypath[1] != "enable_thinking" {
		t.Errorf("ThinkingToggleKeypath = %v, want [chat_template_kwargs enable_thinking]", rc.Provider.ThinkingToggleKeypath)
	}
	if rc.Provider.ThinkingToggleOnValue != true {
		t.Errorf("ThinkingToggleOnValue = %v, want true", rc.Provider.ThinkingToggleOnValue)
	}
	if rc.Provider.ThinkingToggleOffValue != false {
		t.Errorf("ThinkingToggleOffValue = %v, want false", rc.Provider.ThinkingToggleOffValue)
	}
}

func TestLoadConfig_ActiveModelNotFound(t *testing.T) {
	writeTestConfig(t, `
active_provider = "local"

[providers.local]
base_url = "http://localhost:8000/v1"
active_model = "nonexistent"

[providers.local.models.glm47]
model_id = "glm-4.7-flash-q4km"
`)

	_, err := LoadConfig()
	if err == nil {
		t.Fatal("expected error for missing active_model, got nil")
	}
	if !strings.Contains(err.Error(), "nonexistent") {
		t.Errorf("error should mention missing model name: %v", err)
	}
	if !strings.Contains(err.Error(), "glm47") {
		t.Errorf("error should list available models: %v", err)
	}
}

func TestLoadConfig_ActiveModelEmptyModelID(t *testing.T) {
	writeTestConfig(t, `
active_provider = "local"

[providers.local]
base_url = "http://localhost:8000/v1"
active_model = "bad"

[providers.local.models.bad]
model_id = ""
`)

	_, err := LoadConfig()
	if err == nil {
		t.Fatal("expected error for empty model_id, got nil")
	}
	if !strings.Contains(err.Error(), "empty model_id") {
		t.Errorf("error should mention empty model_id: %v", err)
	}
}

func TestLoadConfig_ActiveModelNoModelsMap(t *testing.T) {
	writeTestConfig(t, `
active_provider = "local"

[providers.local]
base_url = "http://localhost:8000/v1"
active_model = "glm47"
`)

	_, err := LoadConfig()
	if err == nil {
		t.Fatal("expected error for active_model with no models map, got nil")
	}
	if !strings.Contains(err.Error(), "no [models] defined") {
		t.Errorf("error should mention no models defined: %v", err)
	}
}

func TestLoadConfig_NoActiveModelPreservesExistingFields(t *testing.T) {
	writeTestConfig(t, `
active_provider = "local"

[providers.local]
base_url = "http://localhost:8000/v1"
primary_model = "model-a"
reasoning_model = "model-b"
summarization_model = "model-c"
thinking_toggle_keypath = ["extra_body", "think"]
`)

	rc, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if rc.Provider.PrimaryModel != "model-a" {
		t.Errorf("PrimaryModel = %q, want %q", rc.Provider.PrimaryModel, "model-a")
	}
	if rc.Provider.ReasoningModel != "model-b" {
		t.Errorf("ReasoningModel = %q, want %q", rc.Provider.ReasoningModel, "model-b")
	}
	if rc.Provider.SummarizationModel != "model-c" {
		t.Errorf("SummarizationModel = %q, want %q", rc.Provider.SummarizationModel, "model-c")
	}
	if len(rc.Provider.ThinkingToggleKeypath) != 2 ||
		rc.Provider.ThinkingToggleKeypath[0] != "extra_body" {
		t.Errorf("ThinkingToggleKeypath = %v, want [extra_body think]", rc.Provider.ThinkingToggleKeypath)
	}
}

func TestLoadConfig_PCLAWModelEnvOverride(t *testing.T) {
	writeTestConfig(t, `
active_provider = "local"

[providers.local]
base_url = "http://localhost:8000/v1"
active_model = "glm47"

[providers.local.models.glm47]
model_id = "glm-4.7-flash-q4km"

[providers.local.models.qwen35]
model_id = "qwen3.5-35b-a3b-q4km"
`)
	t.Setenv("PCLAW_MODEL", "qwen35")

	rc, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if rc.Provider.PrimaryModel != "qwen3.5-35b-a3b-q4km" {
		t.Errorf("PrimaryModel = %q, want %q (env override should select qwen35)", rc.Provider.PrimaryModel, "qwen3.5-35b-a3b-q4km")
	}
}

func TestLoadConfig_ActiveModelNoThinkingToggleKeepsProvider(t *testing.T) {
	writeTestConfig(t, `
active_provider = "local"

[providers.local]
base_url = "http://localhost:8000/v1"
active_model = "plain"
thinking_toggle_keypath = ["extra_body", "think"]
thinking_toggle_on_value = "yes"
thinking_toggle_off_value = "no"

[providers.local.models.plain]
model_id = "plain-model"
`)

	rc, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if rc.Provider.PrimaryModel != "plain-model" {
		t.Errorf("PrimaryModel = %q, want %q", rc.Provider.PrimaryModel, "plain-model")
	}
	// Model has no thinking toggle, so provider-level toggle should be preserved.
	if len(rc.Provider.ThinkingToggleKeypath) != 2 ||
		rc.Provider.ThinkingToggleKeypath[0] != "extra_body" ||
		rc.Provider.ThinkingToggleKeypath[1] != "think" {
		t.Errorf("ThinkingToggleKeypath = %v, want [extra_body think] (preserved from provider)", rc.Provider.ThinkingToggleKeypath)
	}
	if rc.Provider.ThinkingToggleOnValue != "yes" {
		t.Errorf("ThinkingToggleOnValue = %v, want \"yes\"", rc.Provider.ThinkingToggleOnValue)
	}
}

// TestLoadConfig_RealWorldMultiProvider mirrors the actual user config with
// a Vultr provider (flat fields, no toggle) and a local provider (named models
// with toggle). Verifies both resolve correctly depending on active_provider.
func TestLoadConfig_RealWorldMultiProvider(t *testing.T) {
	const cfg = `
active_provider = "local"

[providers.vultr]
api_key_env = "VULTR_API_KEY"
base_url = "https://api.vultrinference.com/v1"
primary_model = "kimi-k2-instruct"
reasoning_model = "gpt-oss-120b"
summarization_model = "qwen2.5-coder-32b-instruct"

[providers.local]
base_url = "http://100.73.235.19:8000/v1"
active_model = "glm47"

[providers.local.models.glm47]
model_id = "glm-4.7-flash-q4km"
thinking_toggle_keypath = ["chat_template_kwargs", "enable_thinking"]

[providers.local.models.qwen35]
model_id = "qwen3.5-35b-a3b-q4km"
thinking_toggle_keypath = ["chat_template_kwargs", "enable_thinking"]
`

	t.Run("local_glm47", func(t *testing.T) {
		writeTestConfig(t, cfg)
		rc, err := LoadConfig()
		if err != nil {
			t.Fatalf("LoadConfig: %v", err)
		}
		if rc.Provider.PrimaryModel != "glm-4.7-flash-q4km" {
			t.Errorf("PrimaryModel = %q, want glm-4.7-flash-q4km", rc.Provider.PrimaryModel)
		}
		if rc.Provider.ReasoningModel != "glm-4.7-flash-q4km" {
			t.Errorf("ReasoningModel = %q, want glm-4.7-flash-q4km", rc.Provider.ReasoningModel)
		}
		if len(rc.Provider.ThinkingToggleKeypath) != 2 {
			t.Errorf("ThinkingToggleKeypath = %v, want [chat_template_kwargs enable_thinking]", rc.Provider.ThinkingToggleKeypath)
		}
	})

	t.Run("local_qwen35_via_env", func(t *testing.T) {
		writeTestConfig(t, cfg)
		t.Setenv("PCLAW_MODEL", "qwen35")
		rc, err := LoadConfig()
		if err != nil {
			t.Fatalf("LoadConfig: %v", err)
		}
		if rc.Provider.PrimaryModel != "qwen3.5-35b-a3b-q4km" {
			t.Errorf("PrimaryModel = %q, want qwen3.5-35b-a3b-q4km", rc.Provider.PrimaryModel)
		}
		if rc.Provider.ReasoningModel != "qwen3.5-35b-a3b-q4km" {
			t.Errorf("ReasoningModel = %q, want qwen3.5-35b-a3b-q4km", rc.Provider.ReasoningModel)
		}
		if len(rc.Provider.ThinkingToggleKeypath) != 2 {
			t.Errorf("ThinkingToggleKeypath = %v, want [chat_template_kwargs enable_thinking]", rc.Provider.ThinkingToggleKeypath)
		}
	})

	t.Run("vultr_flat_fields", func(t *testing.T) {
		writeTestConfig(t, cfg)
		t.Setenv("PCLAW_PROVIDER", "vultr")
		rc, err := LoadConfig()
		if err != nil {
			t.Fatalf("LoadConfig: %v", err)
		}
		if rc.Provider.PrimaryModel != "kimi-k2-instruct" {
			t.Errorf("PrimaryModel = %q, want kimi-k2-instruct", rc.Provider.PrimaryModel)
		}
		if rc.Provider.ReasoningModel != "gpt-oss-120b" {
			t.Errorf("ReasoningModel = %q, want gpt-oss-120b", rc.Provider.ReasoningModel)
		}
		if rc.Provider.SummarizationModel != "qwen2.5-coder-32b-instruct" {
			t.Errorf("SummarizationModel = %q, want qwen2.5-coder-32b-instruct", rc.Provider.SummarizationModel)
		}
		if len(rc.Provider.ThinkingToggleKeypath) != 0 {
			t.Errorf("ThinkingToggleKeypath = %v, want empty (vultr has no toggle)", rc.Provider.ThinkingToggleKeypath)
		}
	})
}
