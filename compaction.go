package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// --- Phase 1: Constants and core types ---

const (
	compactionSizeThreshold = 2048
	compactionKeepMessages  = 8
	compactionTimeout       = 20 * time.Second
	compactionMaxTokens     = 256
)

// ConversationState holds the rolling conversation history with an optional
// accumulated summary of compacted older messages.
type ConversationState struct {
	Messages  []ChatMessage
	Summary   string
	SizeBytes int
}

// NewConversationState returns an empty, ready-to-use ConversationState.
func NewConversationState() *ConversationState {
	return &ConversationState{}
}

// messageContentSize returns the byte length of a message's text content.
func messageContentSize(msg ChatMessage) int {
	return len(streamContentToString(msg.Content))
}

// Append adds a message to the state and updates the size counter.
// Only messages beyond the compactionKeepMessages window are counted toward
// SizeBytes, since the kept tail is always retained and never compacted.
func (cs *ConversationState) Append(msg ChatMessage) {
	cs.Messages = append(cs.Messages, msg)
	if len(cs.Messages) > compactionKeepMessages {
		cs.SizeBytes += messageContentSize(msg)
	}
}

// NeedsCompaction reports whether the conversation exceeds the size threshold.
func (cs *ConversationState) NeedsCompaction() bool {
	return cs.SizeBytes > compactionSizeThreshold
}

// findCompactionSplitIndex returns the index at which to split the conversation:
// messages[:index] will be summarized, messages[index:] will be kept.
//
// Starting from len(messages)-keepCount, it walks backward to find a user-role
// boundary so that no tool_call/tool_result pairs are orphaned.
// Returns 0 if no safe split exists (e.g. the whole conversation fits in keepCount).
func findCompactionSplitIndex(messages []ChatMessage, keepCount int) int {
	if keepCount >= len(messages) {
		return 0
	}
	// Start just before the kept tail.
	start := len(messages) - keepCount
	// Walk backward from start to find a user-role boundary.
	for i := start; i >= 1; i-- {
		if messages[i].Role == "user" {
			return i
		}
	}
	return 0
}

// serializeMessagesForSummary converts a slice of messages into a plain-text
// string suitable for summarization: "role: content\n" per message.
// Tool-call-only assistant messages show "(called tools: name1, name2)".
// Tool result messages with empty content show "(tool result)".
// Messages with no meaningful content are skipped.
func serializeMessagesForSummary(messages []ChatMessage) string {
	var b strings.Builder
	for _, msg := range messages {
		text := streamContentToString(msg.Content)

		switch msg.Role {
		case "assistant":
			if strings.TrimSpace(text) == "" && len(msg.ToolCalls) > 0 {
				// Tool-call-only assistant turn.
				names := make([]string, 0, len(msg.ToolCalls))
				for _, tc := range msg.ToolCalls {
					names = append(names, tc.Function.Name)
				}
				fmt.Fprintf(&b, "assistant: (called tools: %s)\n", strings.Join(names, ", "))
			} else if strings.TrimSpace(text) != "" {
				fmt.Fprintf(&b, "assistant: %s\n", text)
			}
			// Skip empty assistant messages with no tool calls.
		case "tool":
			if strings.TrimSpace(text) == "" {
				fmt.Fprintf(&b, "tool: (tool result)\n")
			} else {
				fmt.Fprintf(&b, "tool: %s\n", text)
			}
		default:
			if strings.TrimSpace(text) != "" {
				fmt.Fprintf(&b, "%s: %s\n", msg.Role, text)
			}
		}
	}
	return b.String()
}

// --- Phase 1h: Context helpers for conversation summary ---

type conversationSummaryContextKey struct{}

// withConversationSummary attaches a summary string to ctx.
func withConversationSummary(ctx context.Context, summary string) context.Context {
	return context.WithValue(ctx, conversationSummaryContextKey{}, summary)
}

// conversationSummaryFromContext retrieves the summary string from ctx.
// Returns "" if none is set.
func conversationSummaryFromContext(ctx context.Context) string {
	s, _ := ctx.Value(conversationSummaryContextKey{}).(string)
	return s
}

// --- Phase 2: Compaction logic ---

// summarizeConversation makes a direct HTTP POST to /chat/completions (bypassing
// runInferenceWithModel to avoid recursion) and returns a compact textual
// summary of the provided conversation content.
//
// When priorSummary is non-empty, the user message combines the prior summary
// with the new content so the model can merge them.
func (a *Agent) summarizeConversation(ctx context.Context, priorSummary, newContent string) (string, error) {
	timeoutCtx, cancel := context.WithTimeout(ctx, compactionTimeout)
	defer cancel()

	systemPrompt := "You are summarizing an AI assistant conversation for context compaction. " +
		"Capture key decisions, facts, task state, and important context. " +
		"When merging a prior summary with new content, prefer new information and let stale details fade. " +
		"Be concise and factual."

	var userMsg string
	if priorSummary != "" {
		userMsg = "PRIOR SUMMARY:\n" + priorSummary + "\n\nNEW CONVERSATION CONTENT:\n" + newContent
	} else {
		userMsg = newContent
	}

	reqBody := ChatCompletionRequest{
		Model:     string(a.summarizationModel),
		MaxTokens: compactionMaxTokens,
		Messages: []ChatMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userMsg},
		},
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("summarize conversation: marshal: %w", err)
	}

	req, err := http.NewRequestWithContext(timeoutCtx, http.MethodPost, a.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("summarize conversation: create request: %w", err)
	}
	if a.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+a.apiKey)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := a.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("summarize conversation: request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("summarize conversation: read response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("summarize conversation: status %d: %s", resp.StatusCode, string(respBody))
	}

	var completion ChatCompletionResponse
	if err := json.Unmarshal(respBody, &completion); err != nil {
		return "", fmt.Errorf("summarize conversation: parse response: %w", err)
	}
	if completion.Error != nil && completion.Error.Message != "" {
		return "", fmt.Errorf("summarize conversation: api error: %s", completion.Error.Message)
	}
	if len(completion.Choices) == 0 {
		return "", fmt.Errorf("summarize conversation: no choices returned")
	}

	content, ok := completion.Choices[0].Message.Content.(string)
	if !ok || strings.TrimSpace(content) == "" {
		return "", fmt.Errorf("summarize conversation: empty content")
	}
	return strings.TrimSpace(content), nil
}

// compactConversation checks whether cs needs compaction and, if so, summarizes
// the older prefix of messages and truncates them from the state.
//
// On summarization failure: emits a warning server event and returns nil
// (compaction failure is non-fatal).
//
// On success: emits a compaction.completed server event with stats.
func (a *Agent) compactConversation(ctx context.Context, cs *ConversationState) error {
	if !cs.NeedsCompaction() {
		return nil
	}

	splitIdx := findCompactionSplitIndex(cs.Messages, compactionKeepMessages)
	if splitIdx == 0 {
		// No safe split point; skip compaction.
		return nil
	}

	prefix := cs.Messages[:splitIdx]
	serialized := serializeMessagesForSummary(prefix)

	summary, err := a.summarizeConversation(ctx, cs.Summary, serialized)
	if err != nil {
		a.emitServerEvent(ctx, ServerLogLevelWarn, "compaction.failed", "conversation compaction failed; keeping full history", map[string]interface{}{
			"error": err.Error(),
		})
		return nil
	}

	kept := cs.Messages[splitIdx:]
	// Recalculate size for kept messages using the same accounting rule as Append:
	// only messages beyond the compactionKeepMessages window count toward SizeBytes.
	newSize := 0
	for i, msg := range kept {
		if i+1 > compactionKeepMessages {
			newSize += messageContentSize(msg)
		}
	}

	oldLen := len(cs.Messages)
	oldSize := cs.SizeBytes

	cs.Messages = kept
	cs.Summary = summary
	cs.SizeBytes = newSize

	a.emitServerEvent(ctx, ServerLogLevelInfo, "compaction.completed", "conversation compacted", map[string]interface{}{
		"messages_before": oldLen,
		"messages_after":  len(cs.Messages),
		"bytes_before":    oldSize,
		"bytes_after":     cs.SizeBytes,
	})

	return nil
}
