package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// --- WebSearchClient.Search tests ---

func TestWebSearchClient_Search_Success(t *testing.T) {
	srv, handler := newMockServer([]mockResponse{
		{status: 200, body: `{
			"query": "Go 1.22 release date",
			"answer": "Go 1.22 was released on February 6, 2024.",
			"results": [
				{
					"title": "Go 1.22 Release Notes",
					"url": "https://go.dev/doc/go1.22",
					"content": "Go 1.22 was released on February 6, 2024.",
					"score": 0.95
				},
				{
					"title": "Go Blog",
					"url": "https://go.dev/blog/go1.22",
					"content": "Announcing Go 1.22",
					"score": 0.80
				}
			],
			"response_time": 0.42
		}`},
	})
	defer srv.Close()

	client := NewWebSearchClient(srv.URL, "test-key", srv.Client(), 5)
	result, err := client.Search(context.Background(), "Go 1.22 release date", "", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if result.Answer != "Go 1.22 was released on February 6, 2024." {
		t.Errorf("unexpected answer: %q", result.Answer)
	}
	if len(result.Sources) != 2 {
		t.Fatalf("expected 2 sources, got %d", len(result.Sources))
	}
	if result.Sources[0].Title != "Go 1.22 Release Notes" {
		t.Errorf("unexpected source title: %q", result.Sources[0].Title)
	}
	if result.Sources[0].URL != "https://go.dev/doc/go1.22" {
		t.Errorf("unexpected source URL: %q", result.Sources[0].URL)
	}

	// Verify request was correct.
	if len(handler.requests) != 1 {
		t.Fatalf("expected 1 request, got %d", len(handler.requests))
	}
	if handler.requests[0].URL.Path != "/search" {
		t.Errorf("unexpected path: %q", handler.requests[0].URL.Path)
	}
	if handler.requests[0].Header.Get("Authorization") != "Bearer test-key" {
		t.Errorf("unexpected auth header: %q", handler.requests[0].Header.Get("Authorization"))
	}

	var reqBody tavilySearchRequest
	if err := json.Unmarshal([]byte(handler.bodies[0]), &reqBody); err != nil {
		t.Fatalf("failed to parse request body: %v", err)
	}
	if reqBody.Query != "Go 1.22 release date" {
		t.Errorf("unexpected query in request: %q", reqBody.Query)
	}
	if !reqBody.IncludeAnswer {
		t.Error("expected include_answer=true")
	}
	if reqBody.MaxResults != 5 {
		t.Errorf("expected max_results=5, got %d", reqBody.MaxResults)
	}
}

func TestWebSearchClient_Search_WithTopicAndDepth(t *testing.T) {
	srv, handler := newMockServer([]mockResponse{
		{status: 200, body: `{"query":"test","results":[],"response_time":0.1}`},
	})
	defer srv.Close()

	client := NewWebSearchClient(srv.URL, "test-key", srv.Client(), 3)
	_, err := client.Search(context.Background(), "AAPL stock price", "finance", "advanced")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var reqBody tavilySearchRequest
	if err := json.Unmarshal([]byte(handler.bodies[0]), &reqBody); err != nil {
		t.Fatalf("failed to parse request body: %v", err)
	}
	if reqBody.Topic != "finance" {
		t.Errorf("expected topic=finance, got %q", reqBody.Topic)
	}
	if reqBody.SearchDepth != "advanced" {
		t.Errorf("expected search_depth=advanced, got %q", reqBody.SearchDepth)
	}
	if reqBody.MaxResults != 3 {
		t.Errorf("expected max_results=3, got %d", reqBody.MaxResults)
	}
}

func TestWebSearchClient_Search_HTTPError(t *testing.T) {
	srv, _ := newMockServer([]mockResponse{
		{status: 401, body: `{"error":"Invalid API key"}`},
	})
	defer srv.Close()

	client := NewWebSearchClient(srv.URL, "bad-key", srv.Client(), 5)
	_, err := client.Search(context.Background(), "test query", "", "")
	if err == nil {
		t.Fatal("expected error for 401 response")
	}
	if !strings.Contains(err.Error(), "status 401") {
		t.Errorf("expected status 401 in error, got: %v", err)
	}
}

func TestWebSearchClient_Search_MalformedJSON(t *testing.T) {
	srv, _ := newMockServer([]mockResponse{
		{status: 200, body: `not json`},
	})
	defer srv.Close()

	client := NewWebSearchClient(srv.URL, "test-key", srv.Client(), 5)
	_, err := client.Search(context.Background(), "test query", "", "")
	if err == nil {
		t.Fatal("expected error for malformed JSON")
	}
	if !strings.Contains(err.Error(), "parse response") {
		t.Errorf("expected parse error, got: %v", err)
	}
}

// --- formatWebSearchResult tests ---

func TestFormatWebSearchResult_WithAnswerAndSources(t *testing.T) {
	result := &WebSearchResult{
		Answer: "Go 1.22 was released on Feb 6, 2024.",
		Sources: []WebSearchSource{
			{Title: "Go Release Notes", URL: "https://go.dev/doc/go1.22", Content: "Full release notes here."},
			{Title: "Go Blog", URL: "https://go.dev/blog", Content: "Blog post about the release."},
		},
	}
	out := formatWebSearchResult(result)
	if !strings.Contains(out, "Answer: Go 1.22 was released on Feb 6, 2024.") {
		t.Error("missing answer in output")
	}
	if !strings.Contains(out, "1. Go Release Notes (https://go.dev/doc/go1.22)") {
		t.Error("missing first source in output")
	}
	if !strings.Contains(out, "2. Go Blog (https://go.dev/blog)") {
		t.Error("missing second source in output")
	}
	if !strings.Contains(out, "Full release notes here.") {
		t.Error("missing first source content")
	}
}

func TestFormatWebSearchResult_NoAnswer(t *testing.T) {
	result := &WebSearchResult{
		Sources: []WebSearchSource{
			{Title: "Example", URL: "https://example.com", Content: "Some content."},
		},
	}
	out := formatWebSearchResult(result)
	if strings.Contains(out, "Answer:") {
		t.Error("should not contain Answer: when answer is empty")
	}
	if !strings.Contains(out, "Sources:") {
		t.Error("should contain Sources: section")
	}
}

func TestFormatWebSearchResult_NoResults(t *testing.T) {
	out := formatWebSearchResult(&WebSearchResult{})
	if out != "No results found." {
		t.Errorf("expected 'No results found.', got %q", out)
	}
}

func TestFormatWebSearchResult_Nil(t *testing.T) {
	out := formatWebSearchResult(nil)
	if out != "No results found." {
		t.Errorf("expected 'No results found.', got %q", out)
	}
}

func TestFormatWebSearchResult_AnswerOnly(t *testing.T) {
	result := &WebSearchResult{
		Answer: "The answer is 42.",
	}
	out := formatWebSearchResult(result)
	if !strings.Contains(out, "Answer: The answer is 42.") {
		t.Error("missing answer in output")
	}
	if strings.Contains(out, "Sources:") {
		t.Error("should not contain Sources: when no sources")
	}
}

// --- web_search tool handler tests ---

func TestWebSearchFunction_Success(t *testing.T) {
	srv, _ := newMockServer([]mockResponse{
		{status: 200, body: `{
			"query": "test",
			"answer": "Test answer.",
			"results": [{"title": "Test", "url": "https://test.com", "content": "Content.", "score": 0.9}],
			"response_time": 0.1
		}`},
	})
	defer srv.Close()

	agent := NewAgent("http://unused", "unused-key", http.DefaultClient, nil, nil, nil)
	agent.webSearchClient = NewWebSearchClient(srv.URL, "test-key", srv.Client(), 5)

	input, _ := json.Marshal(WebSearchInput{Query: "test query"})
	result, err := agent.webSearchFunction(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "Answer: Test answer.") {
		t.Errorf("expected answer in result, got: %s", result)
	}
	if !strings.Contains(result, "https://test.com") {
		t.Errorf("expected URL in result, got: %s", result)
	}
}

func TestWebSearchFunction_EmptyQuery(t *testing.T) {
	agent := NewAgent("http://unused", "unused-key", http.DefaultClient, nil, nil, nil)
	agent.webSearchClient = NewWebSearchClient("http://unused", "key", nil, 5)

	input, _ := json.Marshal(WebSearchInput{Query: ""})
	_, err := agent.webSearchFunction(input)
	if err == nil {
		t.Fatal("expected error for empty query")
	}
	if !strings.Contains(err.Error(), "query is required") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestWebSearchFunction_WhitespaceQuery(t *testing.T) {
	agent := NewAgent("http://unused", "unused-key", http.DefaultClient, nil, nil, nil)
	agent.webSearchClient = NewWebSearchClient("http://unused", "key", nil, 5)

	input, _ := json.Marshal(WebSearchInput{Query: "   "})
	_, err := agent.webSearchFunction(input)
	if err == nil {
		t.Fatal("expected error for whitespace query")
	}
}

// --- configureWebSearch tests ---

func testWebSearchConfig(apiKey string, maxResults int) *ResolvedConfig {
	return &ResolvedConfig{
		Config: Config{
			WebSearch: WebSearchConfig{MaxResults: maxResults},
		},
		WebSearch: ResolvedWebSearch{
			WebSearchConfig: WebSearchConfig{MaxResults: maxResults},
			APIKey:          apiKey,
		},
	}
}

func TestConfigureWebSearch_WithAPIKey(t *testing.T) {
	cfg := testWebSearchConfig("test-tavily-key", 5)

	agent := NewAgent("http://unused", "unused-key", http.DefaultClient, nil, nil, nil)
	configureWebSearch(agent, cfg)

	if agent.webSearchClient == nil {
		t.Fatal("expected webSearchClient to be set")
	}

	// Verify web_search tool is registered.
	found := false
	for _, tool := range agent.tools {
		if tool.Name == "web_search" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected web_search tool to be registered")
	}
}

func TestConfigureWebSearch_WithoutAPIKey(t *testing.T) {
	cfg := testWebSearchConfig("", 5)

	agent := NewAgent("http://unused", "unused-key", http.DefaultClient, nil, nil, nil)
	configureWebSearch(agent, cfg)

	if agent.webSearchClient != nil {
		t.Fatal("expected webSearchClient to be nil when no API key")
	}

	for _, tool := range agent.tools {
		if tool.Name == "web_search" {
			t.Fatal("web_search tool should not be registered without API key")
		}
	}
}

func TestConfigureWebSearch_CustomMaxResults(t *testing.T) {
	cfg := testWebSearchConfig("test-key", 10)

	agent := NewAgent("http://unused", "unused-key", http.DefaultClient, nil, nil, nil)
	configureWebSearch(agent, cfg)

	if agent.webSearchClient == nil {
		t.Fatal("expected webSearchClient to be set")
	}
	if agent.webSearchClient.maxResults != 10 {
		t.Errorf("expected maxResults=10, got %d", agent.webSearchClient.maxResults)
	}
}

func TestConfigureWebSearch_InvalidMaxResults(t *testing.T) {
	cfg := testWebSearchConfig("test-key", 0)

	agent := NewAgent("http://unused", "unused-key", http.DefaultClient, nil, nil, nil)
	configureWebSearch(agent, cfg)

	if agent.webSearchClient == nil {
		t.Fatal("expected webSearchClient to be set")
	}
	if agent.webSearchClient.maxResults != defaultWebSearchMaxResults {
		t.Errorf("expected default maxResults=%d, got %d", defaultWebSearchMaxResults, agent.webSearchClient.maxResults)
	}
}

// --- NewWebSearchClient tests ---

func TestNewWebSearchClient_Defaults(t *testing.T) {
	client := NewWebSearchClient("https://api.tavily.com", "key", nil, 0)
	if client.httpClient != http.DefaultClient {
		t.Error("expected default http client")
	}
	if client.maxResults != defaultWebSearchMaxResults {
		t.Errorf("expected default maxResults=%d, got %d", defaultWebSearchMaxResults, client.maxResults)
	}
}

// --- buildTools integration ---

func TestBuildTools_IncludesWebSearch(t *testing.T) {
	agent := NewAgent("http://unused", "unused-key", http.DefaultClient, nil, nil, nil)
	agent.webSearchClient = NewWebSearchClient("http://unused", "key", nil, 5)
	tools := agent.buildTools(nil)

	found := false
	for _, tool := range tools {
		if tool.Name == "web_search" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected web_search in tools when webSearchClient is set")
	}
}

func TestBuildTools_ExcludesWebSearchWhenNil(t *testing.T) {
	agent := NewAgent("http://unused", "unused-key", http.DefaultClient, nil, nil, nil)
	tools := agent.buildTools(nil)

	for _, tool := range tools {
		if tool.Name == "web_search" {
			t.Fatal("web_search should not be in tools when webSearchClient is nil")
		}
	}
}

// --- Prompt grounding rules ---

func TestPromptBuild_WebSearchGroundingRules(t *testing.T) {
	cfg := DefaultPromptConfig()
	builder := NewSectionedPromptBuilder(cfg)

	// With web_search tool: should include grounding rules.
	prompt := builder.Build(PromptBuildContext{
		Mode:      PromptModeFull,
		ToolNames: []string{"read_file", "web_search"},
	})
	if !strings.Contains(prompt, "ALWAYS call web_search") {
		t.Error("expected web grounding safety rule in prompt")
	}

	// Without web_search tool: should NOT include grounding rules.
	prompt = builder.Build(PromptBuildContext{
		Mode:      PromptModeFull,
		ToolNames: []string{"read_file", "edit_file"},
	})
	if strings.Contains(prompt, "ALWAYS call web_search") {
		t.Error("grounding safety rule should not appear without web_search tool")
	}
}

// --- web_search tool handler with httptest (end-to-end tool dispatch) ---

func TestWebSearchToolDispatch(t *testing.T) {
	// Set up a mock Tavily server.
	tavilyHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/search" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{
			"query": "test",
			"answer": "42",
			"results": [{"title": "Answer", "url": "https://example.com", "content": "The answer is 42.", "score": 0.99}],
			"response_time": 0.05
		}`))
	})
	tavilySrv := httptest.NewServer(tavilyHandler)
	defer tavilySrv.Close()

	agent := NewAgent("http://unused", "unused-key", http.DefaultClient, nil, nil, nil)
	agent.webSearchClient = NewWebSearchClient(tavilySrv.URL, "test-key", tavilySrv.Client(), 5)
	agent.tools = agent.buildTools(nil)

	// Dispatch via executeTool.
	toolCall := ChatToolCall{
		ID:   "call_1",
		Type: "function",
		Function: struct {
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		}{
			Name:      "web_search",
			Arguments: `{"query": "what is the meaning of life"}`,
		},
	}

	msg := agent.executeTool(context.Background(), toolCall)
	if msg.Role != "tool" {
		t.Errorf("expected role=tool, got %q", msg.Role)
	}
	content, ok := msg.Content.(string)
	if !ok {
		t.Fatalf("expected string content, got %T", msg.Content)
	}
	if !strings.Contains(content, "42") {
		t.Errorf("expected answer in tool result, got: %s", content)
	}
	if !strings.Contains(content, "https://example.com") {
		t.Errorf("expected URL in tool result, got: %s", content)
	}
}

// --- Config-driven handling ---

func TestConfigureWebSearch_NilConfig(t *testing.T) {
	agent := NewAgent("http://unused", "unused-key", http.DefaultClient, nil, nil, nil)
	configureWebSearch(agent, nil)

	if agent.webSearchClient != nil {
		t.Error("expected no webSearchClient when config is nil")
	}
}

func TestConfigureWebSearch_MaxResultsOutOfRange(t *testing.T) {
	cfg := testWebSearchConfig("test-key", 50) // > 20

	agent := NewAgent("http://unused", "unused-key", http.DefaultClient, nil, nil, nil)
	configureWebSearch(agent, cfg)

	if agent.webSearchClient == nil {
		t.Fatal("expected webSearchClient to be set")
	}
	// Should fall back to default since 50 > 20.
	if agent.webSearchClient.maxResults != defaultWebSearchMaxResults {
		t.Errorf("expected default maxResults=%d for out-of-range value, got %d", defaultWebSearchMaxResults, agent.webSearchClient.maxResults)
	}
}
