package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type PromptMode string

const (
	PromptModeFull    PromptMode = "full"
	PromptModeMinimal PromptMode = "minimal"
)

type PromptConfig struct {
	AgentName       string
	RoleSummary     string
	Persona         string
	BehaviorRules   []string
	SafetyRules     []string
	RuntimeRules    []string
	MaxPersonaChars int
}

type PromptBuildContext struct {
	Mode      PromptMode
	Transport string
	ToolNames []string
}

type PromptBuilder interface {
	Build(ctx PromptBuildContext) string
}

type SectionedPromptBuilder struct {
	Config PromptConfig
}

func DefaultPromptConfig() PromptConfig {
	return PromptConfig{
		AgentName:   "Codex",
		RoleSummary: "A pragmatic coding agent focused on clear, correct, and tool-effective execution.",
		Persona:     "Direct, concise, and rigorous. Prioritize actionable output and grounded reasoning.",
		BehaviorRules: []string{
			"Be clear about assumptions and tradeoffs.",
			"Prefer concrete next actions over abstract advice.",
			"Keep responses concise unless depth is requested.",
		},
		SafetyRules: []string{
			"Do not invent tool results or file contents.",
			"Do not claim work was done if commands/tests did not run.",
			"When uncertain, state uncertainty and gather evidence first.",
		},
		RuntimeRules: []string{
			"Use available tools deliberately and only when useful.",
			"When tools are provided, choose the smallest sufficient action.",
			"When tools are unavailable, answer directly without tool-call syntax.",
			"Before calling a tool, send one brief plain-language status sentence about what you are about to do.",
			"For delegate_reasoning, explicitly tell the user you are thinking and will return with a complete answer.",
			"If multiple tools are needed, send at most one status sentence before the first tool call.",
			"After tool use, provide a complete final answer rather than only raw tool output.",
			"If a transport supports split markers, insert <<MSG_SPLIT>> at logical boundaries for very long replies.",
			"When using split markers, prefer roughly even chunk sizes and avoid tiny trailing fragments.",
		},
		MaxPersonaChars: 600,
	}
}

func NewSectionedPromptBuilder(cfg PromptConfig) *SectionedPromptBuilder {
	defaults := DefaultPromptConfig()
	if strings.TrimSpace(cfg.AgentName) == "" {
		cfg.AgentName = defaults.AgentName
	}
	if strings.TrimSpace(cfg.RoleSummary) == "" {
		cfg.RoleSummary = defaults.RoleSummary
	}
	if strings.TrimSpace(cfg.Persona) == "" {
		cfg.Persona = defaults.Persona
	}
	if len(cfg.BehaviorRules) == 0 {
		cfg.BehaviorRules = defaults.BehaviorRules
	}
	if len(cfg.SafetyRules) == 0 {
		cfg.SafetyRules = defaults.SafetyRules
	}
	if len(cfg.RuntimeRules) == 0 {
		cfg.RuntimeRules = defaults.RuntimeRules
	}
	if cfg.MaxPersonaChars <= 0 {
		cfg.MaxPersonaChars = defaults.MaxPersonaChars
	}
	return &SectionedPromptBuilder{Config: cfg}
}

func promptConfigFromEnv() PromptConfig {
	cfg := DefaultPromptConfig()

	if v := strings.TrimSpace(os.Getenv("AGENT_NAME")); v != "" {
		cfg.AgentName = v
	}
	if v := strings.TrimSpace(os.Getenv("AGENT_ROLE_SUMMARY")); v != "" {
		cfg.RoleSummary = v
	}

	// If AGENT_PERSONA_FILE is set and readable, it takes precedence over AGENT_PERSONA.
	if personaPath := strings.TrimSpace(os.Getenv("AGENT_PERSONA_FILE")); personaPath != "" {
		data, err := os.ReadFile(personaPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to read AGENT_PERSONA_FILE=%q: %v\n", personaPath, err)
		} else if persona := strings.TrimSpace(string(data)); persona != "" {
			cfg.Persona = persona
		}
	} else if v := strings.TrimSpace(os.Getenv("AGENT_PERSONA")); v != "" {
		cfg.Persona = v
	}

	if raw := strings.TrimSpace(os.Getenv("AGENT_PROMPT_MAX_PERSONA_CHARS")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			fmt.Fprintf(os.Stderr, "Warning: invalid AGENT_PROMPT_MAX_PERSONA_CHARS=%q; defaulting to %d\n", raw, cfg.MaxPersonaChars)
		} else {
			cfg.MaxPersonaChars = n
		}
	}

	return cfg
}

func (b *SectionedPromptBuilder) Build(ctx PromptBuildContext) string {
	mode := ctx.Mode
	if mode == "" {
		mode = PromptModeFull
	}
	toolNames := make([]string, 0, len(ctx.ToolNames))
	hasWebSearch := false
	for _, n := range ctx.ToolNames {
		n = strings.TrimSpace(n)
		if n == "" {
			continue
		}
		toolNames = append(toolNames, n)
		if n == "web_search" {
			hasWebSearch = true
		}
	}

	var sections []string
	if mode == PromptModeFull {
		identity := strings.TrimSpace(strings.Join([]string{
			fmt.Sprintf("Name: %s", b.Config.AgentName),
			fmt.Sprintf("Role: %s", b.Config.RoleSummary),
			fmt.Sprintf("Persona: %s", truncateRunes(strings.TrimSpace(b.Config.Persona), b.Config.MaxPersonaChars)),
		}, "\n"))
		sections = append(sections, formatSection("Identity", identity))
	}

	sections = append(sections, formatSection("Behavior", joinRules(b.Config.BehaviorRules)))
	if mode == PromptModeFull {
		tooling := "Use tools only when they improve correctness or speed."
		if len(toolNames) > 0 {
			tooling += " Available tools: " + strings.Join(toolNames, ", ") + "."
		}
		sections = append(sections, formatSection("Tooling", tooling))
	}
	safetyRules := append([]string{}, b.Config.SafetyRules...)
	if hasWebSearch {
		safetyRules = append(safetyRules,
			"ALWAYS call web_search before answering questions about current events, recent facts, versions, dates, statistics, or anything that may have changed since your training data. Your training data is outdated — do not rely on it for time-sensitive information. Search first, then answer.",
			"Never present unverified information as fact. If you cannot search or find confirmation, explicitly say so.",
		)
	}
	sections = append(sections, formatSection("Safety", joinRules(safetyRules)))

	runtimeRules := append([]string{}, b.Config.RuntimeRules...)
	runtimeRules = append(runtimeRules, fmt.Sprintf("Current date: %s", time.Now().Format("2006-01-02")))
	if strings.TrimSpace(ctx.Transport) != "" {
		runtimeRules = append(runtimeRules, fmt.Sprintf("Transport: %s", strings.TrimSpace(ctx.Transport)))
	}
	sections = append(sections, formatSection("Runtime", joinRules(runtimeRules)))

	return strings.TrimSpace(strings.Join(sections, "\n\n"))
}

func prependSystemPrompt(conversation []ChatMessage, prompt string) []ChatMessage {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return conversation
	}

	trimmed := conversation
	if len(trimmed) > 0 && trimmed[0].Role == "system" {
		trimmed = trimmed[1:]
	}

	out := make([]ChatMessage, 0, len(trimmed)+1)
	out = append(out, ChatMessage{Role: "system", Content: prompt})
	out = append(out, trimmed...)
	return out
}

func formatSection(name, body string) string {
	body = strings.TrimSpace(body)
	if body == "" {
		return fmt.Sprintf("[%s]\n(none)", name)
	}
	return fmt.Sprintf("[%s]\n%s", name, body)
}

func joinRules(rules []string) string {
	out := make([]string, 0, len(rules))
	for _, rule := range rules {
		rule = strings.TrimSpace(rule)
		if rule == "" {
			continue
		}
		out = append(out, "- "+rule)
	}
	if len(out) == 0 {
		return "(none)"
	}
	return strings.Join(out, "\n")
}

func truncateRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}
