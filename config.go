package main

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"
)

// expandTilde replaces a leading "~/" in path with the user's home directory.
func expandTilde(path string) string {
	if strings.HasPrefix(path, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, path[2:])
		}
	}
	return path
}

//go:embed config.default.toml
var defaultConfigTOML string

// Config is the top-level configuration loaded from a TOML file.
type Config struct {
	ActiveProvider string                    `toml:"active_provider"`
	Providers      map[string]ProviderConfig `toml:"providers"`
	Discord        DiscordConfig             `toml:"discord"`
	Agent          AgentConfig               `toml:"agent"`
	Memory         MemoryConfig              `toml:"memory"`
	WebSearch      WebSearchConfig           `toml:"web_search"`
}

// ProviderConfig defines connection details for an inference backend.
type ProviderConfig struct {
	APIKeyEnv          string `toml:"api_key_env"`
	BaseURL            string `toml:"base_url"`
	PrimaryModel       string `toml:"primary_model"`
	ReasoningModel     string `toml:"reasoning_model"`
	SummarizationModel string `toml:"summarization_model"`

	// Named model selection (optional). When ActiveModel is set, the named
	// model's fields override the flat model/toggle fields above at load time.
	ActiveModel string                 `toml:"active_model"`
	Models      map[string]ModelConfig `toml:"models"`

	// Thinking toggle (optional). When ThinkingToggleKeypath is non-empty,
	// the inference client injects a nested field into the request body to
	// control per-request thinking. OnValue defaults to true, OffValue to false.
	ThinkingToggleKeypath  []string    `toml:"thinking_toggle_keypath"`
	ThinkingToggleOnValue  interface{} `toml:"thinking_toggle_on_value"`
	ThinkingToggleOffValue interface{} `toml:"thinking_toggle_off_value"`
}

// ModelConfig defines a named model within a provider.
type ModelConfig struct {
	ModelID                string      `toml:"model_id"`
	ThinkingToggleKeypath  []string    `toml:"thinking_toggle_keypath"`
	ThinkingToggleOnValue  interface{} `toml:"thinking_toggle_on_value"`
	ThinkingToggleOffValue interface{} `toml:"thinking_toggle_off_value"`
}

// DiscordConfig holds Discord bot connection and access control settings.
type DiscordConfig struct {
	BotTokenEnv       string      `toml:"bot_token_env"`
	ApplicationID     string      `toml:"application_id"`
	GuildID           string      `toml:"guild_id"`
	AllowedChannelIDs interface{} `toml:"allowed_channel_ids"` // "all", "none", or []string
	AllowedUserIDs    []string    `toml:"allowed_user_ids"`
}

// ChannelPolicy controls which guild channels the bot responds in.
// DMs are always allowed regardless of policy.
type ChannelPolicy int

const (
	ChannelPolicyAll  ChannelPolicy = iota // respond in all channels
	ChannelPolicyNone                      // guild channels blocked (DM-only)
	ChannelPolicyList                      // only specific channel IDs
)

// AgentConfig holds agent identity and prompt configuration.
type AgentConfig struct {
	Name             string `toml:"name"`
	RoleSummary      string `toml:"role_summary"`
	Persona          string `toml:"persona"`
	PersonaFile      string `toml:"persona_file"`
	MaxPersonaChars  int    `toml:"max_persona_chars"`
	WorkingDirectory string `toml:"working_directory"`
}

// MemoryConfig holds memory subsystem configuration.
type MemoryConfig struct {
	Enabled        bool   `toml:"enabled"`
	Backend        string `toml:"backend"`
	CollectionName string `toml:"collection_name"`
}

// WebSearchConfig holds web search configuration.
type WebSearchConfig struct {
	APIKeyEnv  string `toml:"api_key_env"`
	MaxResults int    `toml:"max_results"`
}

// ResolvedProvider holds the provider configuration with secrets resolved
// from environment variables.
type ResolvedProvider struct {
	ProviderConfig
	APIKey string // resolved from APIKeyEnv
}

// ResolvedDiscord holds the Discord configuration with secrets resolved.
type ResolvedDiscord struct {
	DiscordConfig
	BotToken          string              // resolved from BotTokenEnv
	ChannelPolicy     ChannelPolicy       // parsed from AllowedChannelIDs
	AllowedChannelSet map[string]struct{} // populated only when ChannelPolicy == ChannelPolicyList
	AllowedUserSet    map[string]struct{} // built from AllowedUserIDs
}

// ResolvedWebSearch holds the web search configuration with secrets resolved.
type ResolvedWebSearch struct {
	WebSearchConfig
	APIKey string // resolved from APIKeyEnv
}

// ResolvedConfig is the fully resolved configuration ready for use.
type ResolvedConfig struct {
	Config
	Provider  ResolvedProvider
	Discord   ResolvedDiscord
	WebSearch ResolvedWebSearch
}

// configFilePath returns the path to the config file, checking in order:
// 1. PCLAW_CONFIG env var
// 2. $XDG_CONFIG_HOME/pclaw/config.toml
// 3. ~/.config/pclaw/config.toml
func configFilePath() string {
	if p := strings.TrimSpace(os.Getenv("PCLAW_CONFIG")); p != "" {
		return p
	}
	if xdg := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); xdg != "" {
		return filepath.Join(xdg, "pclaw", "config.toml")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".config", "pclaw", "config.toml")
	}
	return filepath.Join(home, ".config", "pclaw", "config.toml")
}

// ensureConfigFile creates the config file from the embedded default if it
// doesn't already exist. Parent directories are created as needed.
func ensureConfigFile(path string) error {
	if _, err := os.Stat(path); err == nil {
		return nil // file exists
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create config directory %s: %w", dir, err)
	}
	if err := os.WriteFile(path, []byte(defaultConfigTOML), 0o644); err != nil {
		return fmt.Errorf("write default config to %s: %w", path, err)
	}
	return nil
}

// LoadConfig loads and resolves the pClaw configuration. It ensures the config
// file exists (creating from embedded defaults on first run), parses the TOML,
// resolves environment variable references, and validates the active provider.
func LoadConfig() (*ResolvedConfig, error) {
	path := configFilePath()

	if err := ensureConfigFile(path); err != nil {
		return nil, err
	}

	var cfg Config
	if _, err := toml.DecodeFile(path, &cfg); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", path, err)
	}

	// Apply PCLAW_PROVIDER override.
	if override := strings.TrimSpace(os.Getenv("PCLAW_PROVIDER")); override != "" {
		cfg.ActiveProvider = override
	}

	if cfg.ActiveProvider == "" {
		return nil, fmt.Errorf("active_provider is not set in %s", path)
	}

	providerCfg, ok := cfg.Providers[cfg.ActiveProvider]
	if !ok {
		available := make([]string, 0, len(cfg.Providers))
		for name := range cfg.Providers {
			available = append(available, name)
		}
		return nil, fmt.Errorf("active provider %q not found in config; available: %s", cfg.ActiveProvider, strings.Join(available, ", "))
	}

	// Apply PCLAW_MODEL override.
	if override := strings.TrimSpace(os.Getenv("PCLAW_MODEL")); override != "" {
		providerCfg.ActiveModel = override
	}

	// Resolve named model into flat provider fields.
	if providerCfg.ActiveModel != "" {
		if len(providerCfg.Models) == 0 {
			return nil, fmt.Errorf("active_model %q set but provider %q has no [models] defined", providerCfg.ActiveModel, cfg.ActiveProvider)
		}
		modelCfg, found := providerCfg.Models[providerCfg.ActiveModel]
		if !found {
			available := make([]string, 0, len(providerCfg.Models))
			for name := range providerCfg.Models {
				available = append(available, name)
			}
			return nil, fmt.Errorf("active_model %q not found in provider %q; available: %s", providerCfg.ActiveModel, cfg.ActiveProvider, strings.Join(available, ", "))
		}
		if modelCfg.ModelID == "" {
			return nil, fmt.Errorf("model %q in provider %q has empty model_id", providerCfg.ActiveModel, cfg.ActiveProvider)
		}
		providerCfg.PrimaryModel = modelCfg.ModelID
		providerCfg.ReasoningModel = modelCfg.ModelID
		providerCfg.SummarizationModel = modelCfg.ModelID
		if len(modelCfg.ThinkingToggleKeypath) > 0 {
			providerCfg.ThinkingToggleKeypath = modelCfg.ThinkingToggleKeypath
			providerCfg.ThinkingToggleOnValue = modelCfg.ThinkingToggleOnValue
			providerCfg.ThinkingToggleOffValue = modelCfg.ThinkingToggleOffValue
		}
	}

	// Resolve secrets from environment variables.
	resolved := &ResolvedConfig{
		Config: cfg,
	}

	resolved.Provider = ResolvedProvider{
		ProviderConfig: providerCfg,
	}
	if providerCfg.APIKeyEnv != "" {
		resolved.Provider.APIKey = strings.TrimSpace(os.Getenv(providerCfg.APIKeyEnv))
	}

	channelPolicy, channelSet, err := resolveChannelPolicy(cfg.Discord.AllowedChannelIDs)
	if err != nil {
		return nil, fmt.Errorf("discord.allowed_channel_ids: %w", err)
	}
	resolved.Discord = ResolvedDiscord{
		DiscordConfig:     cfg.Discord,
		ChannelPolicy:     channelPolicy,
		AllowedChannelSet: channelSet,
		AllowedUserSet:    sliceToSet(cfg.Discord.AllowedUserIDs),
	}
	if cfg.Discord.BotTokenEnv != "" {
		resolved.Discord.BotToken = strings.TrimSpace(os.Getenv(cfg.Discord.BotTokenEnv))
	}

	resolved.WebSearch = ResolvedWebSearch{
		WebSearchConfig: cfg.WebSearch,
	}
	if cfg.WebSearch.APIKeyEnv != "" {
		resolved.WebSearch.APIKey = strings.TrimSpace(os.Getenv(cfg.WebSearch.APIKeyEnv))
	}

	return resolved, nil
}

// resolveChannelPolicy interprets the allowed_channel_ids config value.
// Accepts "all", "none", an array of channel ID strings, or nil/empty (defaults to "all").
func resolveChannelPolicy(v interface{}) (ChannelPolicy, map[string]struct{}, error) {
	if v == nil {
		return ChannelPolicyAll, nil, nil
	}
	switch val := v.(type) {
	case string:
		switch strings.ToLower(strings.TrimSpace(val)) {
		case "all", "":
			return ChannelPolicyAll, nil, nil
		case "none":
			return ChannelPolicyNone, nil, nil
		default:
			return 0, nil, fmt.Errorf("invalid string value %q (expected \"all\" or \"none\")", val)
		}
	case []string:
		if len(val) == 0 {
			return ChannelPolicyAll, nil, nil
		}
		return ChannelPolicyList, sliceToSet(val), nil
	case []interface{}:
		ids := make([]string, 0, len(val))
		for i, item := range val {
			s, ok := item.(string)
			if !ok {
				return 0, nil, fmt.Errorf("element %d is not a string", i)
			}
			ids = append(ids, s)
		}
		if len(ids) == 0 {
			return ChannelPolicyAll, nil, nil
		}
		return ChannelPolicyList, sliceToSet(ids), nil
	default:
		return 0, nil, fmt.Errorf("expected \"all\", \"none\", or an array of channel IDs")
	}
}

// sliceToSet converts a string slice to a set (map[string]struct{}),
// trimming whitespace and skipping empty values.
func sliceToSet(items []string) map[string]struct{} {
	out := make(map[string]struct{}, len(items))
	for _, item := range items {
		v := strings.TrimSpace(item)
		if v != "" {
			out[v] = struct{}{}
		}
	}
	return out
}
