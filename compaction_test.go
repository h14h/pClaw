package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// --- 5a: TestMessageContentSize ---

func TestMessageContentSize(t *testing.T) {
	tests := []struct {
		name    string
		content interface{}
		want    int
	}{
		{"string content", "hello world", 11},
		{"array content", []interface{}{
			map[string]interface{}{"type": "text", "text": "foo"},
			map[string]interface{}{"type": "text", "text": "bar"},
		}, 6},
		{"nil content", nil, 0},
		{"empty string", "", 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			msg := ChatMessage{Role: "user", Content: tc.content}
			got := messageContentSize(msg)
			if got != tc.want {
				t.Fatalf("messageContentSize = %d, want %d", got, tc.want)
			}
		})
	}
}

// --- 5b: TestConversationStateAppend ---

func TestConversationStateAppend(t *testing.T) {
	cs := NewConversationState()
	if cs.SizeBytes != 0 || len(cs.Messages) != 0 {
		t.Fatal("expected empty state")
	}

	// Messages within the keep window do not accumulate into SizeBytes.
	for i := 0; i < compactionKeepMessages; i++ {
		cs.Append(ChatMessage{Role: "user", Content: "hello"})
	}
	if cs.SizeBytes != 0 {
		t.Fatalf("SizeBytes = %d after %d messages (within keep window), want 0", cs.SizeBytes, compactionKeepMessages)
	}
	if len(cs.Messages) != compactionKeepMessages {
		t.Fatalf("len(Messages) = %d, want %d", len(cs.Messages), compactionKeepMessages)
	}

	// The (compactionKeepMessages+1)th message starts accumulating.
	cs.Append(ChatMessage{Role: "assistant", Content: "world!"})
	if cs.SizeBytes != 6 {
		t.Fatalf("SizeBytes = %d after first excess message, want 6", cs.SizeBytes)
	}

	cs.Append(ChatMessage{Role: "user", Content: "again"})
	if cs.SizeBytes != 11 {
		t.Fatalf("SizeBytes = %d after second excess message, want 11", cs.SizeBytes)
	}
}

// --- 5c: TestNeedsCompaction ---

func TestNeedsCompaction(t *testing.T) {
	cs := NewConversationState()

	// Below threshold
	cs.SizeBytes = compactionSizeThreshold - 1
	if cs.NeedsCompaction() {
		t.Fatal("expected no compaction below threshold")
	}

	// At threshold
	cs.SizeBytes = compactionSizeThreshold
	if cs.NeedsCompaction() {
		t.Fatal("expected no compaction at threshold (needs strictly greater)")
	}

	// Above threshold
	cs.SizeBytes = compactionSizeThreshold + 1
	if !cs.NeedsCompaction() {
		t.Fatal("expected compaction above threshold")
	}
}

// --- 5d: TestFindCompactionSplitIndex ---

func TestFindCompactionSplitIndex(t *testing.T) {
	t.Run("keepCount >= len returns 0", func(t *testing.T) {
		msgs := []ChatMessage{
			{Role: "user"},
			{Role: "assistant"},
		}
		if got := findCompactionSplitIndex(msgs, 2); got != 0 {
			t.Fatalf("got %d, want 0", got)
		}
		if got := findCompactionSplitIndex(msgs, 10); got != 0 {
			t.Fatalf("got %d, want 0", got)
		}
	})

	t.Run("simple split lands on user", func(t *testing.T) {
		// [user0, asst1, user2, asst3, user4, asst5], keepCount=2
		// start = 6-2 = 4, messages[4]="user" → return 4
		msgs := []ChatMessage{
			{Role: "user"},
			{Role: "assistant"},
			{Role: "user"},
			{Role: "assistant"},
			{Role: "user"},
			{Role: "assistant"},
		}
		got := findCompactionSplitIndex(msgs, 2)
		if got != 4 {
			t.Fatalf("got %d, want 4", got)
		}
	})

	t.Run("walks back to user to avoid tool pair orphan", func(t *testing.T) {
		// [user0, asst1+toolcall, tool2, asst3, user4, asst5+toolcall, tool6, asst7], keepCount=4
		// start = 8-4 = 4, messages[4]="user" → return 4
		msgs := []ChatMessage{
			{Role: "user"},
			{Role: "assistant", ToolCalls: []ChatToolCall{{ID: "1"}}},
			{Role: "tool"},
			{Role: "assistant"},
			{Role: "user"},
			{Role: "assistant", ToolCalls: []ChatToolCall{{ID: "2"}}},
			{Role: "tool"},
			{Role: "assistant"},
		}
		got := findCompactionSplitIndex(msgs, 4)
		if got != 4 {
			t.Fatalf("got %d, want 4", got)
		}
	})

	t.Run("walks backward when start is not user", func(t *testing.T) {
		// [user0, asst1, tool2, asst3], keepCount=2
		// start = 4-2 = 2, messages[2]="tool" → messages[1]="assistant" → i=1, no user, return 0
		// Wait: loop is i>=1, so i=2: tool, i=1: assistant → return 0
		msgs := []ChatMessage{
			{Role: "user"},
			{Role: "assistant"},
			{Role: "tool"},
			{Role: "assistant"},
		}
		got := findCompactionSplitIndex(msgs, 2)
		if got != 0 {
			t.Fatalf("got %d, want 0 (no safe split)", got)
		}
	})

	t.Run("walks back to earlier user", func(t *testing.T) {
		// [user0, asst1, user2, tool3, asst4], keepCount=2
		// start = 5-2 = 3, messages[3]="tool" → messages[2]="user" → return 2
		msgs := []ChatMessage{
			{Role: "user"},
			{Role: "assistant"},
			{Role: "user"},
			{Role: "tool"},
			{Role: "assistant"},
		}
		got := findCompactionSplitIndex(msgs, 2)
		if got != 2 {
			t.Fatalf("got %d, want 2", got)
		}
	})
}

// --- 5e: TestSerializeMessagesForSummary ---

func TestSerializeMessagesForSummary(t *testing.T) {
	t.Run("basic user and assistant", func(t *testing.T) {
		msgs := []ChatMessage{
			{Role: "user", Content: "hello"},
			{Role: "assistant", Content: "world"},
		}
		got := serializeMessagesForSummary(msgs)
		if !strings.Contains(got, "user: hello") {
			t.Errorf("missing user line: %q", got)
		}
		if !strings.Contains(got, "assistant: world") {
			t.Errorf("missing assistant line: %q", got)
		}
	})

	t.Run("tool-call-only assistant shows called tools", func(t *testing.T) {
		msgs := []ChatMessage{
			{
				Role: "assistant",
				ToolCalls: []ChatToolCall{
					{ID: "1", Function: ChatToolCallFunction{Name: "read_file"}},
					{ID: "2", Function: ChatToolCallFunction{Name: "list_files"}},
				},
			},
		}
		got := serializeMessagesForSummary(msgs)
		if !strings.Contains(got, "(called tools: read_file, list_files)") {
			t.Errorf("expected tool call annotation, got: %q", got)
		}
	})

	t.Run("empty tool result shows placeholder", func(t *testing.T) {
		msgs := []ChatMessage{
			{Role: "tool", Content: ""},
		}
		got := serializeMessagesForSummary(msgs)
		if !strings.Contains(got, "(tool result)") {
			t.Errorf("expected tool result placeholder, got: %q", got)
		}
	})

	t.Run("tool result with content shows content", func(t *testing.T) {
		msgs := []ChatMessage{
			{Role: "tool", Content: "file contents here"},
		}
		got := serializeMessagesForSummary(msgs)
		if !strings.Contains(got, "tool: file contents here") {
			t.Errorf("expected tool content, got: %q", got)
		}
	})

	t.Run("empty assistant message skipped", func(t *testing.T) {
		msgs := []ChatMessage{
			{Role: "assistant", Content: ""},
		}
		got := serializeMessagesForSummary(msgs)
		if strings.TrimSpace(got) != "" {
			t.Errorf("expected empty output for empty assistant, got: %q", got)
		}
	})

	t.Run("whitespace-only messages skipped", func(t *testing.T) {
		msgs := []ChatMessage{
			{Role: "user", Content: "   "},
		}
		got := serializeMessagesForSummary(msgs)
		if strings.TrimSpace(got) != "" {
			t.Errorf("expected empty output for whitespace user, got: %q", got)
		}
	})
}

// --- Helper: build an agent pointing at a mock server ---

func newTestAgentWithServer(t *testing.T, serverURL string, client *http.Client) *Agent {
	t.Helper()
	agent := &Agent{
		baseURL:            serverURL,
		apiKey:             "test-key",
		summarizationModel: Summarization,
		httpClient:         client,
	}
	return agent
}

// --- 5f: TestSummarizeConversation_Success ---

func TestSummarizeConversation_Success(t *testing.T) {
	respBody := `{"id":"x","model":"gpt-oss-120b","choices":[{"index":0,"message":{"role":"assistant","content":"compact summary"}}]}`
	srv, h := newMockServer([]mockResponse{{status: 200, body: respBody}})
	defer srv.Close()

	agent := newTestAgentWithServer(t, srv.URL, srv.Client())
	got, err := agent.summarizeConversation(context.Background(), "", "user: hi\nassistant: hello\n")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "compact summary" {
		t.Fatalf("got %q, want %q", got, "compact summary")
	}

	// Verify request body
	if len(h.bodies) != 1 {
		t.Fatalf("expected 1 request, got %d", len(h.bodies))
	}
	var req ChatCompletionRequest
	if err := json.Unmarshal([]byte(h.bodies[0]), &req); err != nil {
		t.Fatalf("parse request: %v", err)
	}
	if req.Model != string(Summarization) {
		t.Errorf("model = %q, want %q", req.Model, string(Summarization))
	}
	if req.MaxTokens != compactionMaxTokens {
		t.Errorf("max_tokens = %d, want %d", req.MaxTokens, compactionMaxTokens)
	}
	if len(req.Messages) != 2 {
		t.Fatalf("expected 2 messages (system + user), got %d", len(req.Messages))
	}
	if req.Messages[0].Role != "system" {
		t.Errorf("messages[0].role = %q, want system", req.Messages[0].Role)
	}
	userContent, _ := req.Messages[1].Content.(string)
	if !strings.Contains(userContent, "user: hi") {
		t.Errorf("user message missing conversation content: %q", userContent)
	}
}

// --- 5g: TestSummarizeConversation_WithPriorSummary ---

func TestSummarizeConversation_WithPriorSummary(t *testing.T) {
	respBody := `{"id":"x","model":"gpt-oss-120b","choices":[{"index":0,"message":{"role":"assistant","content":"merged summary"}}]}`
	srv, h := newMockServer([]mockResponse{{status: 200, body: respBody}})
	defer srv.Close()

	agent := newTestAgentWithServer(t, srv.URL, srv.Client())
	_, err := agent.summarizeConversation(context.Background(), "old summary", "new content")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var req ChatCompletionRequest
	if err := json.Unmarshal([]byte(h.bodies[0]), &req); err != nil {
		t.Fatalf("parse request: %v", err)
	}
	userContent, _ := req.Messages[1].Content.(string)
	if !strings.Contains(userContent, "PRIOR SUMMARY:") {
		t.Errorf("expected PRIOR SUMMARY: prefix, got: %q", userContent)
	}
	if !strings.Contains(userContent, "NEW CONVERSATION CONTENT:") {
		t.Errorf("expected NEW CONVERSATION CONTENT: prefix, got: %q", userContent)
	}
	if !strings.Contains(userContent, "old summary") {
		t.Errorf("expected prior summary in user message, got: %q", userContent)
	}
	if !strings.Contains(userContent, "new content") {
		t.Errorf("expected new content in user message, got: %q", userContent)
	}
}

// --- 5h: TestSummarizeConversation_Error ---

func TestSummarizeConversation_Error(t *testing.T) {
	srv, _ := newMockServer([]mockResponse{{status: 500, body: `{"error":"internal"}`}})
	defer srv.Close()

	agent := newTestAgentWithServer(t, srv.URL, srv.Client())
	_, err := agent.summarizeConversation(context.Background(), "", "content")
	if err == nil {
		t.Fatal("expected error from HTTP 500")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Errorf("expected status 500 in error, got: %v", err)
	}
}

// --- Helpers for compaction tests ---

// buildLargeCS builds a ConversationState with >compactionSizeThreshold bytes.
// It creates pairs of user/assistant messages so split index logic works cleanly.
// Each message has msgSize bytes of content.
func buildLargeCS(msgCount, msgSize int) *ConversationState {
	cs := NewConversationState()
	content := strings.Repeat("x", msgSize)
	for i := 0; i < msgCount; i++ {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		cs.Append(ChatMessage{Role: role, Content: content})
	}
	return cs
}

// --- 5i: TestCompactConversation_Performs ---

func TestCompactConversation_Performs(t *testing.T) {
	summaryText := "compacted summary"
	respBody := `{"id":"x","model":"gpt-oss-120b","choices":[{"index":0,"message":{"role":"assistant","content":"` + summaryText + `"}}]}`
	srv, _ := newMockServer([]mockResponse{{status: 200, body: respBody}})
	defer srv.Close()

	agent := newTestAgentWithServer(t, srv.URL, srv.Client())

	// 12 alternating user/assistant messages, each 1100 bytes → 13200 total > 12000 threshold
	// keepCount=10, start=12-10=2, messages[2]="user" → split at 2
	// After: messages[2:] kept (10 msgs), summary set
	cs := buildLargeCS(12, 1100)
	if !cs.NeedsCompaction() {
		t.Fatalf("precondition: expected NeedsCompaction = true, SizeBytes=%d", cs.SizeBytes)
	}
	msgsBefore := len(cs.Messages)
	sizeBefore := cs.SizeBytes

	if err := agent.compactConversation(context.Background(), cs); err != nil {
		t.Fatalf("compactConversation: %v", err)
	}

	if cs.Summary != summaryText {
		t.Errorf("Summary = %q, want %q", cs.Summary, summaryText)
	}
	if len(cs.Messages) >= msgsBefore {
		t.Errorf("messages not truncated: was %d, now %d", msgsBefore, len(cs.Messages))
	}
	if cs.SizeBytes >= sizeBefore {
		t.Errorf("SizeBytes not reduced: was %d, now %d", sizeBefore, cs.SizeBytes)
	}

	// Verify size was correctly recalculated under keep-window accounting:
	// only kept messages beyond the compactionKeepMessages window count.
	expectedSize := 0
	for i, m := range cs.Messages {
		if i+1 > compactionKeepMessages {
			expectedSize += messageContentSize(m)
		}
	}
	if cs.SizeBytes != expectedSize {
		t.Errorf("SizeBytes = %d, want recalculated %d", cs.SizeBytes, expectedSize)
	}
}

// --- 5j: TestCompactConversation_BelowThreshold ---

func TestCompactConversation_BelowThreshold(t *testing.T) {
	srv, h := newMockServer(nil)
	defer srv.Close()

	agent := newTestAgentWithServer(t, srv.URL, srv.Client())
	cs := NewConversationState()
	cs.Append(ChatMessage{Role: "user", Content: "hi"})
	cs.Append(ChatMessage{Role: "assistant", Content: "hello"})

	originalSize := cs.SizeBytes
	if err := agent.compactConversation(context.Background(), cs); err != nil {
		t.Fatalf("compactConversation: %v", err)
	}

	if len(h.requests) != 0 {
		t.Errorf("expected no HTTP requests for below-threshold, got %d", len(h.requests))
	}
	if cs.SizeBytes != originalSize {
		t.Errorf("SizeBytes changed: was %d, now %d", originalSize, cs.SizeBytes)
	}
}

// --- 5k: TestCompactConversation_FailureNonFatal ---

func TestCompactConversation_FailureNonFatal(t *testing.T) {
	srv, _ := newMockServer([]mockResponse{{status: 500, body: `{"error":"fail"}`}})
	defer srv.Close()

	agent := newTestAgentWithServer(t, srv.URL, srv.Client())
	cs := buildLargeCS(12, 1100)
	originalMsgs := make([]ChatMessage, len(cs.Messages))
	copy(originalMsgs, cs.Messages)
	originalSummary := cs.Summary

	// Should return nil even on HTTP error
	err := agent.compactConversation(context.Background(), cs)
	if err != nil {
		t.Fatalf("expected nil error (non-fatal), got: %v", err)
	}
	// Conversation should be unchanged
	if len(cs.Messages) != len(originalMsgs) {
		t.Errorf("messages changed: was %d, now %d", len(originalMsgs), len(cs.Messages))
	}
	if cs.Summary != originalSummary {
		t.Errorf("summary changed unexpectedly: was %q, now %q", originalSummary, cs.Summary)
	}
}

// --- 5l: TestCompactConversation_TurnBoundary ---

func TestCompactConversation_TurnBoundary(t *testing.T) {
	summaryText := "boundary summary"
	respBody := `{"id":"x","model":"gpt-oss-120b","choices":[{"index":0,"message":{"role":"assistant","content":"` + summaryText + `"}}]}`
	srv, h := newMockServer([]mockResponse{{status: 200, body: respBody}})
	defer srv.Close()

	agent := newTestAgentWithServer(t, srv.URL, srv.Client())

	// Build a large conversation where the naive split (start) lands on "tool",
	// forcing a walk-back to a user message.
	// Layout (0-indexed):
	//   0: user (1000 bytes)     ← safe split target
	//   1: assistant+tool_call (1000 bytes)
	//   2: tool result (1000 bytes)
	//   3: assistant (1000 bytes)
	//   4: user (1000 bytes)     ← keepCount=10 start is well past this
	//   ... fill 8 more user/assistant pairs to push over threshold
	// Actually let's keep it simple:
	//
	// 14 messages, each 1000 bytes = 14000 > 12000
	// Structure: [user, asst+tc, tool, user, asst+tc, tool, user, asst, user, asst, user, asst, user, asst]
	// keepCount=10, start=14-10=4
	// messages[4]="asst+tc" → walk back → messages[3]="user" → split=3
	// Kept: messages[3:] (11 messages), all tool pairs intact.

	content := strings.Repeat("y", 1010)
	cs := NewConversationState()
	cs.Append(ChatMessage{Role: "user", Content: content})                                            // 0
	cs.Append(ChatMessage{Role: "assistant", ToolCalls: []ChatToolCall{{ID: "tc1"}}, Content: ""})    // 1
	cs.Append(ChatMessage{Role: "tool", Content: content})                                            // 2
	cs.Append(ChatMessage{Role: "user", Content: content})                                            // 3 ← expected split
	cs.Append(ChatMessage{Role: "assistant", ToolCalls: []ChatToolCall{{ID: "tc2"}}, Content: ""})    // 4
	cs.Append(ChatMessage{Role: "tool", Content: content})                                            // 5
	cs.Append(ChatMessage{Role: "assistant", Content: content})                                       // 6
	cs.Append(ChatMessage{Role: "user", Content: content})                                            // 7
	cs.Append(ChatMessage{Role: "assistant", Content: content})                                       // 8
	cs.Append(ChatMessage{Role: "user", Content: content})                                            // 9
	cs.Append(ChatMessage{Role: "assistant", Content: content})                                       // 10
	cs.Append(ChatMessage{Role: "user", Content: content})                                            // 11
	cs.Append(ChatMessage{Role: "assistant", Content: content})                                       // 12
	cs.Append(ChatMessage{Role: "user", Content: content})                                            // 13

	if !cs.NeedsCompaction() {
		t.Fatalf("precondition: needs compaction, SizeBytes=%d", cs.SizeBytes)
	}

	if err := agent.compactConversation(context.Background(), cs); err != nil {
		t.Fatalf("compactConversation: %v", err)
	}

	// Verify compaction happened and no tool pair is orphaned
	if len(h.requests) == 0 {
		t.Fatal("expected HTTP request for compaction")
	}

	// The kept messages (starting from the split) should begin with "user"
	if len(cs.Messages) == 0 {
		t.Fatal("expected non-empty messages after compaction")
	}
	if cs.Messages[0].Role != "user" {
		t.Errorf("after compaction, messages[0].Role = %q, want user (no orphaned tool pairs)", cs.Messages[0].Role)
	}
	if cs.Summary != summaryText {
		t.Errorf("Summary = %q, want %q", cs.Summary, summaryText)
	}
}

// --- 5m: TestConversationSummaryContext ---

func TestConversationSummaryContext(t *testing.T) {
	t.Run("round-trip context value", func(t *testing.T) {
		ctx := context.Background()
		ctx = withConversationSummary(ctx, "my summary")
		got := conversationSummaryFromContext(ctx)
		if got != "my summary" {
			t.Fatalf("got %q, want %q", got, "my summary")
		}
	})

	t.Run("empty context returns empty string", func(t *testing.T) {
		got := conversationSummaryFromContext(context.Background())
		if got != "" {
			t.Fatalf("got %q, want empty", got)
		}
	})

	t.Run("withSystemPrompt includes Conversation Summary section", func(t *testing.T) {
		// Create a minimal agent with a prompt builder but no memory client.
		agent := &Agent{
			baseURL:        "http://unused",
			apiKey:         "key",
			promptBuilder:  NewSectionedPromptBuilder(DefaultPromptConfig()),
			promptTransport: "cli",
			httpClient:     http.DefaultClient,
		}

		summaryText := "this is the prior summary"
		ctx := withConversationSummary(context.Background(), summaryText)

		msgs := []ChatMessage{
			{Role: "user", Content: "what do you know?"},
		}
		result := agent.withSystemPrompt(ctx, msgs, nil, PromptModeMinimal)

		if len(result) == 0 || result[0].Role != "system" {
			t.Fatal("expected system message prepended")
		}
		sysContent, ok := result[0].Content.(string)
		if !ok {
			t.Fatal("system content is not a string")
		}
		if !strings.Contains(sysContent, "[Conversation Summary]") {
			t.Errorf("system prompt missing [Conversation Summary] section, got:\n%s", sysContent)
		}
		if !strings.Contains(sysContent, summaryText) {
			t.Errorf("system prompt missing summary text %q, got:\n%s", summaryText, sysContent)
		}
	})

	t.Run("withSystemPrompt omits Conversation Summary when not set", func(t *testing.T) {
		agent := &Agent{
			baseURL:        "http://unused",
			apiKey:         "key",
			promptBuilder:  NewSectionedPromptBuilder(DefaultPromptConfig()),
			promptTransport: "cli",
			httpClient:     http.DefaultClient,
		}

		msgs := []ChatMessage{
			{Role: "user", Content: "hello"},
		}
		result := agent.withSystemPrompt(context.Background(), msgs, nil, PromptModeMinimal)

		if len(result) == 0 || result[0].Role != "system" {
			t.Fatal("expected system message")
		}
		sysContent, _ := result[0].Content.(string)
		if strings.Contains(sysContent, "[Conversation Summary]") {
			t.Errorf("system prompt should not contain [Conversation Summary] when not set")
		}
	})
}

