package main

import (
	"context"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestDelegationPolicyHarness_E2E(t *testing.T) {
	if os.Getenv("RUN_DELEGATION_HARNESS") != "1" {
		t.Skip("set RUN_DELEGATION_HARNESS=1 to run delegation policy harness")
	}

	baseURL, apiKey := requireRealVultrConfig(t)
	agent := NewAgent(baseURL, apiKey, http.DefaultClient, nil, nil, nil)

	runs := intEnvOrDefault(t, "DELEGATION_HARNESS_RUNS", 2)
	if runs < 1 {
		t.Fatalf("DELEGATION_HARNESS_RUNS must be >= 1, got %d", runs)
	}
	minOpinionRate := floatEnvOrDefault(t, "DELEGATION_HARNESS_MIN_OPINION_RATE", 0.80)
	maxSimpleRate := floatEnvOrDefault(t, "DELEGATION_HARNESS_MAX_SIMPLE_RATE", 0.20)
	minOpinionPromptRate := floatEnvOrDefault(t, "DELEGATION_HARNESS_MIN_OPINION_PROMPT_RATE", 0.50)

	opinionPrompts := []string{
		"Our startup can optimize for speed of shipping or long-term reliability this year, but not both equally. Give a clear recommendation with tradeoffs and decision criteria.",
		"I can choose between joining an early-stage startup or a stable large company. Evaluate this from risk tolerance, learning, compensation trajectory, and optionality; then recommend by profile type.",
		"Should governments require licensing for high-capability AI systems? Provide a balanced position, strongest arguments on both sides, and your final stance.",
		"For a new B2B SaaS product with a small team, should we choose a monolith first or microservices first? Give a reasoned perspective and exceptions.",
		"Two high-performing engineers are in persistent conflict and velocity is dropping. Propose a manager response strategy and explain why it should work.",
	}

	simplePrompts := []string{
		"What is 17 * 19? Return only the number.",
		"Write a two-sentence definition of HTTP status code 404.",
		"Convert this JSON to minified form: { \"a\": 1, \"b\": [2,3] }",
		"What day comes after Monday?",
		"Lowercase this text only: HELLO WORLD",
	}

	opinionDelegationsByPrompt, opinionDelegationsTotal, opinionTotal := runDelegationSuite(t, agent, opinionPrompts, runs)
	simpleDelegationsByPrompt, simpleDelegationsTotal, simpleTotal := runDelegationSuite(t, agent, simplePrompts, runs)
	_ = simpleDelegationsByPrompt // retained for future per-prompt constraints.

	opinionRate := float64(opinionDelegationsTotal) / float64(opinionTotal)
	simpleRate := float64(simpleDelegationsTotal) / float64(simpleTotal)
	t.Logf("delegation harness: opinion=%d/%d (%.2f) simple=%d/%d (%.2f)",
		opinionDelegationsTotal, opinionTotal, opinionRate,
		simpleDelegationsTotal, simpleTotal, simpleRate,
	)

	for prompt, delegatedCount := range opinionDelegationsByPrompt {
		rate := float64(delegatedCount) / float64(runs)
		if rate < minOpinionPromptRate {
			t.Fatalf("opinion prompt delegation rate too low: %.2f < %.2f; prompt=%q", rate, minOpinionPromptRate, prompt)
		}
	}

	if opinionRate < minOpinionRate {
		t.Fatalf("opinion delegation rate too low: %.2f < %.2f", opinionRate, minOpinionRate)
	}
	if simpleRate > maxSimpleRate {
		t.Fatalf("simple delegation rate too high: %.2f > %.2f", simpleRate, maxSimpleRate)
	}
}

func runDelegationSuite(t *testing.T, agent *Agent, prompts []string, runs int) (map[string]int, int, int) {
	t.Helper()

	delegationsByPrompt := make(map[string]int, len(prompts))
	totalDelegations := 0
	totalCalls := 0

	for _, prompt := range prompts {
		key := strings.TrimSpace(prompt)
		for i := 0; i < runs; i++ {
			delegated := inferenceUsesDelegationWithRetry(t, agent, prompt)
			totalCalls++
			if delegated {
				delegationsByPrompt[key]++
				totalDelegations++
			}
		}
	}

	return delegationsByPrompt, totalDelegations, totalCalls
}

func inferenceUsesDelegationWithRetry(t *testing.T, agent *Agent, prompt string) bool {
	t.Helper()

	const maxAttempts = 3
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		msg, err := agent.runInference(ctx, []ChatMessage{{
			Role:    "user",
			Content: prompt,
		}})
		cancel()
		if err != nil {
			if attempt == maxAttempts {
				t.Fatalf("runInference failed after %d attempts: %v", maxAttempts, err)
			}
			time.Sleep(500 * time.Millisecond)
			continue
		}
		for _, call := range msg.ToolCalls {
			if call.Function.Name == "delegate_reasoning" {
				return true
			}
		}
		return false
	}
	return false
}

func intEnvOrDefault(t *testing.T, key string, defaultValue int) int {
	t.Helper()

	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return defaultValue
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		t.Fatalf("invalid %s: %q", key, raw)
	}
	return parsed
}

func floatEnvOrDefault(t *testing.T, key string, defaultValue float64) float64 {
	t.Helper()

	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return defaultValue
	}
	parsed, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		t.Fatalf("invalid %s: %q", key, raw)
	}
	return parsed
}
