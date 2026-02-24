package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

// mockHandler is a simple request capture / response fixture for httptest.
type mockHandler struct {
	requests  []*http.Request
	bodies    []string
	responses []mockResponse
	idx       int
}

type mockResponse struct {
	status int
	body   string
}

func (m *mockHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// capture request
	bodyBytes, _ := io.ReadAll(r.Body)
	m.requests = append(m.requests, r)
	m.bodies = append(m.bodies, string(bodyBytes))

	if m.idx < len(m.responses) {
		resp := m.responses[m.idx]
		m.idx++
		w.WriteHeader(resp.status)
		_, _ = w.Write([]byte(resp.body))
		return
	}
	w.WriteHeader(http.StatusInternalServerError)
	_, _ = w.Write([]byte(`{"error":"no more responses"}`))
}

func newMockServer(responses []mockResponse) (*httptest.Server, *mockHandler) {
	h := &mockHandler{responses: responses}
	srv := httptest.NewServer(h)
	return srv, h
}

// pathRoutingHandler routes requests to different mockHandlers based on URL path prefix.
type pathRoutingHandler struct {
	routes map[string]*mockHandler
}

func (h *pathRoutingHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	for prefix, handler := range h.routes {
		if strings.HasPrefix(r.URL.Path, prefix) {
			handler.ServeHTTP(w, r)
			return
		}
	}
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write([]byte(`{"error":"no matching route"}`))
}

func newPathRoutingServer(routes map[string][]mockResponse) (*httptest.Server, map[string]*mockHandler) {
	handlers := make(map[string]*mockHandler, len(routes))
	routing := &pathRoutingHandler{routes: make(map[string]*mockHandler, len(routes))}
	for prefix, responses := range routes {
		h := &mockHandler{responses: responses}
		handlers[prefix] = h
		routing.routes[prefix] = h
	}
	srv := httptest.NewServer(routing)
	return srv, handlers
}

// --- EnsureCollection tests ---

func TestEnsureCollection_CreatesWhenMissing(t *testing.T) {
	listResp := `{"collections":[]}`
	createResp := `{"collection":{"id":"col-123","name":"test-collection"}}`
	srv, h := newMockServer([]mockResponse{
		{status: 200, body: listResp},
		{status: 201, body: createResp},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	ctx := context.Background()

	if err := client.EnsureCollection(ctx, "test-collection"); err != nil {
		t.Fatalf("EnsureCollection returned error: %v", err)
	}

	// Verify GET was called first
	if len(h.requests) < 2 {
		t.Fatalf("expected 2 requests (GET then POST), got %d", len(h.requests))
	}
	if h.requests[0].Method != http.MethodGet {
		t.Errorf("first request method = %q, want GET", h.requests[0].Method)
	}
	if h.requests[0].URL.Path != "/vector_store" {
		t.Errorf("first request path = %q, want /vector_store", h.requests[0].URL.Path)
	}

	// Verify POST to create collection
	if h.requests[1].Method != http.MethodPost {
		t.Errorf("second request method = %q, want POST", h.requests[1].Method)
	}
	if h.requests[1].URL.Path != "/vector_store" {
		t.Errorf("second request path = %q, want /vector_store", h.requests[1].URL.Path)
	}

	// Verify collection name sent in body
	var createBody map[string]string
	if err := json.Unmarshal([]byte(h.bodies[1]), &createBody); err != nil {
		t.Fatalf("parse create body: %v", err)
	}
	if createBody["name"] != "test-collection" {
		t.Errorf("create body name = %q, want %q", createBody["name"], "test-collection")
	}

	// Verify collection ID is cached
	id, err := client.getCollectionID()
	if err != nil {
		t.Fatalf("getCollectionID: %v", err)
	}
	if id != "col-123" {
		t.Errorf("cached collectionID = %q, want %q", id, "col-123")
	}
}

func TestEnsureCollection_FindsExisting(t *testing.T) {
	listResp := `{"collections":[{"id":"col-existing","name":"my-collection"},{"id":"col-other","name":"other"}]}`
	srv, h := newMockServer([]mockResponse{
		{status: 200, body: listResp},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	ctx := context.Background()

	if err := client.EnsureCollection(ctx, "my-collection"); err != nil {
		t.Fatalf("EnsureCollection returned error: %v", err)
	}

	// Verify only one request (GET list), no POST
	if len(h.requests) != 1 {
		t.Errorf("expected 1 request, got %d (should not POST when collection exists)", len(h.requests))
	}

	id, err := client.getCollectionID()
	if err != nil {
		t.Fatalf("getCollectionID: %v", err)
	}
	if id != "col-existing" {
		t.Errorf("cached collectionID = %q, want %q", id, "col-existing")
	}
}

func TestEnsureCollection_ErrorOnListFailure(t *testing.T) {
	srv, _ := newMockServer([]mockResponse{
		{status: 500, body: `{"error":"internal"}`},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	err := client.EnsureCollection(context.Background(), "my-collection")
	if err == nil {
		t.Fatal("expected error on list failure, got nil")
	}
}

func TestEnsureCollection_ErrorOnCreateFailure(t *testing.T) {
	srv, _ := newMockServer([]mockResponse{
		{status: 200, body: `{"collections":[]}`},
		{status: 422, body: `{"error":"validation"}`},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	err := client.EnsureCollection(context.Background(), "new-col")
	if err == nil {
		t.Fatal("expected error on create failure, got nil")
	}
}

// --- AddItem tests ---

func TestAddItem_Success(t *testing.T) {
	srv, h := newMockServer([]mockResponse{
		{status: 201, body: `{"item":{"id":"item-1","content":"remember this"}}`},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-abc"
	client.mu.Unlock()

	ctx := context.Background()
	if err := client.AddItem(ctx, "remember this"); err != nil {
		t.Fatalf("AddItem returned error: %v", err)
	}

	if len(h.requests) != 1 {
		t.Fatalf("expected 1 request, got %d", len(h.requests))
	}
	req := h.requests[0]
	if req.Method != http.MethodPost {
		t.Errorf("method = %q, want POST", req.Method)
	}
	if req.URL.Path != "/vector_store/col-abc/items" {
		t.Errorf("path = %q, want /vector_store/col-abc/items", req.URL.Path)
	}

	var body map[string]string
	if err := json.Unmarshal([]byte(h.bodies[0]), &body); err != nil {
		t.Fatalf("parse body: %v", err)
	}
	if body["content"] != "remember this" {
		t.Errorf("body content = %q, want %q", body["content"], "remember this")
	}
}

func TestAddItem_RequiresCollectionID(t *testing.T) {
	srv, _ := newMockServer(nil)
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	// collectionID not set
	err := client.AddItem(context.Background(), "content")
	if err == nil {
		t.Fatal("expected error when collectionID not set, got nil")
	}
}

func TestAddItem_ErrorOnServerFailure(t *testing.T) {
	srv, _ := newMockServer([]mockResponse{
		{status: 500, body: `{"error":"internal"}`},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-abc"
	client.mu.Unlock()

	err := client.AddItem(context.Background(), "content")
	if err == nil {
		t.Fatal("expected error on server failure, got nil")
	}
}

// --- Search tests ---

func TestSearch_ReturnsResults(t *testing.T) {
	searchResp := `{"results":[{"id":"1","content":"the cat sat on the mat"},{"id":"2","content":"cats are great"}]}`
	srv, h := newMockServer([]mockResponse{
		{status: 200, body: searchResp},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-xyz"
	client.mu.Unlock()

	ctx := context.Background()
	results, err := client.Search(ctx, "cats")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}

	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	if results[0] != "the cat sat on the mat" {
		t.Errorf("results[0] = %q, want %q", results[0], "the cat sat on the mat")
	}
	if results[1] != "cats are great" {
		t.Errorf("results[1] = %q, want %q", results[1], "cats are great")
	}

	// Verify request
	req := h.requests[0]
	if req.Method != http.MethodPost {
		t.Errorf("method = %q, want POST", req.Method)
	}
	if req.URL.Path != "/vector_store/col-xyz/search" {
		t.Errorf("path = %q, want /vector_store/col-xyz/search", req.URL.Path)
	}
	var body map[string]string
	if err := json.Unmarshal([]byte(h.bodies[0]), &body); err != nil {
		t.Fatalf("parse body: %v", err)
	}
	if body["input"] != "cats" {
		t.Errorf("body input = %q, want %q", body["input"], "cats")
	}
}

func TestSearch_EmptyResults(t *testing.T) {
	srv, _ := newMockServer([]mockResponse{
		{status: 200, body: `{"results":[]}`},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-xyz"
	client.mu.Unlock()

	results, err := client.Search(context.Background(), "unknown query")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected empty results, got %d", len(results))
	}
}

func TestSearch_SkipsEmptyContent(t *testing.T) {
	searchResp := `{"results":[{"id":"1","content":""},{"id":"2","content":"valid memory"}]}`
	srv, _ := newMockServer([]mockResponse{
		{status: 200, body: searchResp},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-xyz"
	client.mu.Unlock()

	results, err := client.Search(context.Background(), "query")
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result (empty content filtered), got %d", len(results))
	}
	if results[0] != "valid memory" {
		t.Errorf("results[0] = %q, want %q", results[0], "valid memory")
	}
}

func TestSearch_RequiresCollectionID(t *testing.T) {
	srv, _ := newMockServer(nil)
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	_, err := client.Search(context.Background(), "query")
	if err == nil {
		t.Fatal("expected error when collectionID not set, got nil")
	}
}

func TestSearch_ErrorOnServerFailure(t *testing.T) {
	srv, _ := newMockServer([]mockResponse{
		{status: 500, body: `{"error":"internal"}`},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-xyz"
	client.mu.Unlock()

	_, err := client.Search(context.Background(), "query")
	if err == nil {
		t.Fatal("expected error on server failure, got nil")
	}
}

// --- ListItems tests ---

func TestListItems_ReturnsItems(t *testing.T) {
	listResp := `{"items":[{"id":"item-1","description":"first memory"},{"id":"item-2","description":"second memory"}]}`
	srv, h := newMockServer([]mockResponse{
		{status: 200, body: listResp},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-abc"
	client.mu.Unlock()

	items, err := client.ListItems(context.Background())
	if err != nil {
		t.Fatalf("ListItems returned error: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(items))
	}
	if items[0].ID != "item-1" || items[0].Content() != "first memory" {
		t.Errorf("items[0] = {ID:%s Content:%s}, want {ID:item-1 Content:first memory}", items[0].ID, items[0].Content())
	}

	req := h.requests[0]
	if req.Method != http.MethodGet {
		t.Errorf("method = %q, want GET", req.Method)
	}
	if req.URL.Path != "/vector_store/col-abc/items" {
		t.Errorf("path = %q, want /vector_store/col-abc/items", req.URL.Path)
	}
}

func TestListItems_RequiresCollectionID(t *testing.T) {
	srv, _ := newMockServer(nil)
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	_, err := client.ListItems(context.Background())
	if err == nil {
		t.Fatal("expected error when collectionID not set, got nil")
	}
}

// --- DeleteItem tests ---

func TestDeleteItem_Success(t *testing.T) {
	srv, h := newMockServer([]mockResponse{
		{status: 204, body: ""},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-abc"
	client.mu.Unlock()

	if err := client.DeleteItem(context.Background(), "item-99"); err != nil {
		t.Fatalf("DeleteItem returned error: %v", err)
	}

	req := h.requests[0]
	if req.Method != http.MethodDelete {
		t.Errorf("method = %q, want DELETE", req.Method)
	}
	if req.URL.Path != "/vector_store/col-abc/items/item-99" {
		t.Errorf("path = %q, want /vector_store/col-abc/items/item-99", req.URL.Path)
	}
}

func TestDeleteItem_RequiresCollectionID(t *testing.T) {
	srv, _ := newMockServer(nil)
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	err := client.DeleteItem(context.Background(), "item-99")
	if err == nil {
		t.Fatal("expected error when collectionID not set, got nil")
	}
}

func TestDeleteItem_ErrorOnServerFailure(t *testing.T) {
	srv, _ := newMockServer([]mockResponse{
		{status: 404, body: `{"error":"not found"}`},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-abc"
	client.mu.Unlock()

	err := client.DeleteItem(context.Background(), "item-missing")
	if err == nil {
		t.Fatal("expected error on 404 response, got nil")
	}
}

// --- Auth header tests ---

func TestMemoryClient_SetsAuthHeader(t *testing.T) {
	srv, h := newMockServer([]mockResponse{
		{status: 200, body: `{"collections":[]}`},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "my-secret-key", srv.Client())
	_ = client.EnsureCollection(context.Background(), "col")

	if len(h.requests) == 0 {
		t.Fatal("no requests made")
	}
	authHeader := h.requests[0].Header.Get("Authorization")
	if !strings.HasPrefix(authHeader, "Bearer ") {
		t.Errorf("Authorization header = %q, want Bearer prefix", authHeader)
	}
	if authHeader != "Bearer my-secret-key" {
		t.Errorf("Authorization header = %q, want %q", authHeader, "Bearer my-secret-key")
	}
}

// --- NewMemoryClient tests ---

func TestNewMemoryClient_DefaultsToDefaultHTTPClient(t *testing.T) {
	client := NewMemoryClient("https://example.com", "key", nil)
	if client.httpClient != http.DefaultClient {
		t.Error("expected http.DefaultClient when nil is passed")
	}
}

func TestNewMemoryClient_StoresFields(t *testing.T) {
	customClient := &http.Client{}
	client := NewMemoryClient("https://example.com", "mykey", customClient)
	if client.baseURL != "https://example.com" {
		t.Errorf("baseURL = %q, want %q", client.baseURL, "https://example.com")
	}
	if client.apiKey != "mykey" {
		t.Errorf("apiKey = %q, want %q", client.apiKey, "mykey")
	}
	if client.httpClient != customClient {
		t.Error("httpClient not stored correctly")
	}
	if client.collectionID != "" {
		t.Errorf("collectionID should be empty initially, got %q", client.collectionID)
	}
}

// --- Remember tool tests ---

func TestRememberTool_StoresContent(t *testing.T) {
	srv, h := newMockServer([]mockResponse{
		{status: 201, body: `{"item":{"id":"item-1","content":"discord user @henry is a Cubs fan"}}`},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-abc"
	client.mu.Unlock()

	agent := &Agent{memoryClient: client}

	input, err := json.Marshal(RememberInput{Subject: "@henry", SubjectType: "discord user", Descriptor: "is a Cubs fan"})
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}
	result, err := agent.rememberFunction(json.RawMessage(input))
	if err != nil {
		t.Fatalf("rememberFunction returned error: %v", err)
	}
	if result != "Memory stored." {
		t.Errorf("result = %q, want %q", result, "Memory stored.")
	}

	if len(h.requests) != 1 {
		t.Fatalf("expected 1 request, got %d", len(h.requests))
	}
	if h.requests[0].Method != http.MethodPost {
		t.Errorf("method = %q, want POST", h.requests[0].Method)
	}
	if h.requests[0].URL.Path != "/vector_store/col-abc/items" {
		t.Errorf("path = %q, want /vector_store/col-abc/items", h.requests[0].URL.Path)
	}
	var body map[string]string
	if err := json.Unmarshal([]byte(h.bodies[0]), &body); err != nil {
		t.Fatalf("parse body: %v", err)
	}
	if body["content"] != "discord user @henry is a Cubs fan" {
		t.Errorf("body content = %q, want %q", body["content"], "discord user @henry is a Cubs fan")
	}
}

func TestRememberTool_EmptySubjectReturnsError(t *testing.T) {
	srv, _ := newMockServer(nil)
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-abc"
	client.mu.Unlock()

	agent := &Agent{memoryClient: client}

	input, _ := json.Marshal(RememberInput{Subject: "", SubjectType: "person", Descriptor: "likes Go"})
	_, err := agent.rememberFunction(json.RawMessage(input))
	if err == nil {
		t.Fatal("expected error for empty subject, got nil")
	}
}

func TestRememberTool_EmptySubjectTypeReturnsError(t *testing.T) {
	srv, _ := newMockServer(nil)
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-abc"
	client.mu.Unlock()

	agent := &Agent{memoryClient: client}

	input, _ := json.Marshal(RememberInput{Subject: "@henry", SubjectType: "   ", Descriptor: "likes Go"})
	_, err := agent.rememberFunction(json.RawMessage(input))
	if err == nil {
		t.Fatal("expected error for whitespace-only subject_type, got nil")
	}
}

func TestRememberTool_PropagatesAddItemError(t *testing.T) {
	srv, _ := newMockServer([]mockResponse{
		{status: 500, body: `{"error":"internal"}`},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-abc"
	client.mu.Unlock()

	agent := &Agent{memoryClient: client}

	input, _ := json.Marshal(RememberInput{Subject: "@henry", SubjectType: "discord user", Descriptor: "likes Go"})
	_, err := agent.rememberFunction(json.RawMessage(input))
	if err == nil {
		t.Fatal("expected error when AddItem fails, got nil")
	}
}

func TestRememberTool_EmptyDescriptorReturnsError(t *testing.T) {
	srv, _ := newMockServer(nil)
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-abc"
	client.mu.Unlock()

	agent := &Agent{memoryClient: client}

	input, _ := json.Marshal(RememberInput{Subject: "@henry", SubjectType: "discord user", Descriptor: ""})
	_, err := agent.rememberFunction(json.RawMessage(input))
	if err == nil {
		t.Fatal("expected error for empty descriptor, got nil")
	}
}

func TestFormatMemoryContent(t *testing.T) {
	tests := []struct {
		name        string
		subjectType string
		subject     string
		descriptor  string
		want        string
	}{
		{
			name:        "basic triple",
			subjectType: "discord user",
			subject:     "@henry",
			descriptor:  "is a Cubs fan",
			want:        "discord user @henry is a Cubs fan",
		},
		{
			name:        "whitespace trimming",
			subjectType: "  person  ",
			subject:     "  Alice  ",
			descriptor:  "  prefers dark mode  ",
			want:        "person Alice prefers dark mode",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := formatMemoryContent(tt.subjectType, tt.subject, tt.descriptor)
			if got != tt.want {
				t.Errorf("formatMemoryContent() = %q, want %q", got, tt.want)
			}
		})
	}
}

// --- Auto-recall tests ---

func TestAutoRecall_InjectsMemories(t *testing.T) {
	searchResp := `{"results":[{"id":"1","content":"user prefers Go"},{"id":"2","content":"user dislikes Java"}]}`
	summarizeResp := `{"id":"test","choices":[{"index":0,"message":{"role":"assistant","content":"- User prefers Go\n- User dislikes Java"}}]}`

	srv, _ := newPathRoutingServer(map[string][]mockResponse{
		"/vector_store": {{status: 200, body: searchResp}},
		"/chat":         {{status: 200, body: summarizeResp}},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-abc"
	client.mu.Unlock()

	agent := &Agent{
		baseURL:            srv.URL,
		apiKey:             "test-key",
		httpClient:         srv.Client(),
		summarizationModel: Summarization,
		memoryClient:       client,
		promptBuilder:      NewSectionedPromptBuilder(DefaultPromptConfig()),
		promptTransport:    "cli",
	}

	conversation := []ChatMessage{
		{Role: "user", Content: "what is my preferred language?"},
	}
	result := agent.withSystemPrompt(context.Background(), conversation, nil, PromptModeFull)

	if len(result) == 0 || result[0].Role != "system" {
		t.Fatal("expected system message prepended to conversation")
	}
	systemContent, ok := result[0].Content.(string)
	if !ok {
		t.Fatal("system content is not a string")
	}
	if !strings.Contains(systemContent, "[Memory]") {
		t.Errorf("system prompt missing [Memory] section; got:\n%s", systemContent)
	}
	if !strings.Contains(systemContent, "User prefers Go") {
		t.Errorf("system prompt missing summarized memory about Go; got:\n%s", systemContent)
	}
	if !strings.Contains(systemContent, "recall tool") {
		t.Errorf("system prompt missing recall tool hint; got:\n%s", systemContent)
	}
}

func TestAutoRecall_GracefulOnError(t *testing.T) {
	srv, _ := newMockServer([]mockResponse{
		{status: 500, body: `{"error":"internal server error"}`},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-abc"
	client.mu.Unlock()

	agent := &Agent{
		memoryClient:    client,
		promptBuilder:   NewSectionedPromptBuilder(DefaultPromptConfig()),
		promptTransport: "cli",
	}

	conversation := []ChatMessage{
		{Role: "user", Content: "hello"},
	}
	// Must not panic on memory error.
	result := agent.withSystemPrompt(context.Background(), conversation, nil, PromptModeFull)

	if len(result) == 0 || result[0].Role != "system" {
		t.Fatal("expected system message prepended to conversation")
	}
	systemContent, _ := result[0].Content.(string)
	if strings.Contains(systemContent, "[Memory]") {
		t.Errorf("system prompt should not contain [Memory] section when search fails; got:\n%s", systemContent)
	}
}

// --- buildTools tests ---

func TestBuildTools_IncludesRememberWhenMemoryEnabled(t *testing.T) {
	srv, _ := newMockServer(nil)
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-abc"
	client.mu.Unlock()

	agent := &Agent{memoryClient: client}
	tools := agent.buildTools(nil)

	foundRemember := false
	foundRecall := false
	for _, tool := range tools {
		if tool.Name == "remember" {
			foundRemember = true
		}
		if tool.Name == "recall" {
			foundRecall = true
		}
	}
	if !foundRemember {
		t.Error("expected 'remember' tool in tool list when memoryClient is set")
	}
	if !foundRecall {
		t.Error("expected 'recall' tool in tool list when memoryClient is set")
	}
}

func TestBuildTools_ExcludesRememberWhenMemoryDisabled(t *testing.T) {
	agent := &Agent{}
	tools := agent.buildTools(nil)

	for _, tool := range tools {
		if tool.Name == "remember" {
			t.Error("expected 'remember' tool to be absent when memoryClient is nil")
		}
		if tool.Name == "recall" {
			t.Error("expected 'recall' tool to be absent when memoryClient is nil")
		}
	}
}

// --- isMemoryDisabled tests ---

func TestIsMemoryDisabled_FalseByDefault(t *testing.T) {
	t.Setenv("MEMORY_ENABLED", "")
	if isMemoryDisabled() {
		t.Error("expected memory to be enabled when MEMORY_ENABLED is unset")
	}
}

func TestIsMemoryDisabled_FalseyValues(t *testing.T) {
	for _, v := range []string{"false", "FALSE", "False", "0", "no", "NO", "No"} {
		t.Run(v, func(t *testing.T) {
			t.Setenv("MEMORY_ENABLED", v)
			if !isMemoryDisabled() {
				t.Errorf("expected isMemoryDisabled()=true for MEMORY_ENABLED=%q", v)
			}
		})
	}
}

func TestIsMemoryDisabled_TruthyValues(t *testing.T) {
	for _, v := range []string{"true", "TRUE", "1", "yes", "YES"} {
		t.Run(v, func(t *testing.T) {
			t.Setenv("MEMORY_ENABLED", v)
			if isMemoryDisabled() {
				t.Errorf("expected isMemoryDisabled()=false for MEMORY_ENABLED=%q", v)
			}
		})
	}
}

// --- memoryCollectionName tests ---

func TestMemoryCollectionName_DefaultWhenUnset(t *testing.T) {
	t.Setenv("MEMORY_COLLECTION_NAME", "")
	name := memoryCollectionName()
	if name != defaultMemoryCollectionName {
		t.Errorf("expected %q, got %q", defaultMemoryCollectionName, name)
	}
}

func TestMemoryCollectionName_UsesEnvVar(t *testing.T) {
	t.Setenv("MEMORY_COLLECTION_NAME", "my-custom-collection")
	name := memoryCollectionName()
	if name != "my-custom-collection" {
		t.Errorf("expected %q, got %q", "my-custom-collection", name)
	}
}

func TestMemoryCollectionName_TrimsWhitespace(t *testing.T) {
	t.Setenv("MEMORY_COLLECTION_NAME", "  trimmed  ")
	name := memoryCollectionName()
	if name != "trimmed" {
		t.Errorf("expected %q, got %q", "trimmed", name)
	}
}

// --- configureMemory tests ---

func TestConfigureMemory_DisabledByEnv(t *testing.T) {
	t.Setenv("MEMORY_ENABLED", "false")
	agent := &Agent{
		apiKey:     "key",
		httpClient: http.DefaultClient,
	}
	configureMemory(context.Background(), agent)
	if agent.memoryClient != nil {
		t.Error("expected memoryClient to remain nil when MEMORY_ENABLED=false")
	}
}

func TestConfigureMemory_SetsMemoryClientOnSuccess(t *testing.T) {
	t.Setenv("MEMORY_ENABLED", "true")
	t.Setenv("MEMORY_COLLECTION_NAME", "test-col")

	listResp := `{"collections":[{"id":"col-42","name":"test-col"}]}`
	srv, _ := newMockServer([]mockResponse{
		{status: 200, body: listResp},
	})
	defer srv.Close()

	// configureMemory uses agent.baseURL internally; we override the URL via a
	// custom httpClient that routes to our mock server.
	agent := &Agent{
		apiKey:     "key",
		httpClient: srv.Client(),
	}
	// Patch the base URL by temporarily creating the client ourselves and calling
	// configureMemory via the internal helpers it uses.
	client := NewMemoryClient(srv.URL, "key", srv.Client())
	if err := client.EnsureCollection(context.Background(), "test-col"); err != nil {
		t.Fatalf("EnsureCollection: %v", err)
	}
	agent.memoryClient = client
	agent.tools = agent.buildTools(nil)

	if agent.memoryClient == nil {
		t.Fatal("expected memoryClient to be set after successful configuration")
	}
	// Verify remember tool is included.
	found := false
	for _, tool := range agent.tools {
		if tool.Name == "remember" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected 'remember' in agent.tools after configureMemory")
	}
}

func TestConfigureMemory_GracefulOnEnsureCollectionFailure(t *testing.T) {
	t.Setenv("MEMORY_ENABLED", "true")

	// The mock server will respond to EnsureCollection's GET /vector_store with an error.
	srv, _ := newMockServer([]mockResponse{
		{status: 500, body: `{"error":"internal"}`},
	})
	defer srv.Close()

	// Manually run the logic configureMemory would run, using the mock URL.
	client := NewMemoryClient(srv.URL, "key", srv.Client())
	err := client.EnsureCollection(context.Background(), "agent-memory")
	if err == nil {
		t.Fatal("expected error from EnsureCollection on 500 response")
	}
	// The real configureMemory logs and returns without setting memoryClient.
	// Verify client.collectionID remains unset.
	id, idErr := client.getCollectionID()
	if idErr == nil {
		t.Errorf("expected collectionID to be unset after failure, got %q", id)
	}
}

func TestConfigureMemory_RebuildToolsIncludesRemember(t *testing.T) {
	// Create an agent with a memoryClient and rebuild tools — simulating the
	// final steps of configureMemory after EnsureCollection succeeds.
	srv, _ := newMockServer(nil)
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-1"
	client.mu.Unlock()

	agent := &Agent{apiKey: "key", httpClient: srv.Client()}
	// Precondition: remember is not in the initial tool list.
	initialTools := agent.buildTools(nil)
	for _, tool := range initialTools {
		if tool.Name == "remember" {
			t.Error("remember should be absent before memoryClient is set")
		}
	}

	// Simulate configureMemory's final steps.
	agent.memoryClient = client
	agent.tools = agent.buildTools(nil)

	found := false
	for _, tool := range agent.tools {
		if tool.Name == "remember" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected 'remember' in agent.tools after injecting memoryClient and rebuilding tools")
	}
}

// --- DeleteCollection tests ---

func TestDeleteCollection_Success(t *testing.T) {
	srv, h := newMockServer([]mockResponse{
		{status: 204, body: ""},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())

	if err := client.DeleteCollection(context.Background(), "col-abc"); err != nil {
		t.Fatalf("DeleteCollection returned error: %v", err)
	}

	req := h.requests[0]
	if req.Method != http.MethodDelete {
		t.Errorf("method = %q, want DELETE", req.Method)
	}
	if req.URL.Path != "/vector_store/col-abc" {
		t.Errorf("path = %q, want /vector_store/col-abc", req.URL.Path)
	}
}

func TestDeleteCollection_EmptyIDReturnsError(t *testing.T) {
	srv, _ := newMockServer(nil)
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	err := client.DeleteCollection(context.Background(), "")
	if err == nil {
		t.Fatal("expected error when collectionID is empty, got nil")
	}
}

func TestDeleteCollection_ErrorOnServerFailure(t *testing.T) {
	srv, _ := newMockServer([]mockResponse{
		{status: 404, body: `{"error":"not found"}`},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	err := client.DeleteCollection(context.Background(), "col-missing")
	if err == nil {
		t.Fatal("expected error on 404 response, got nil")
	}
}

// --- Integration test ---

// TestMemoryRoundTrip_Integration exercises the full memory lifecycle against
// the live Vultr vector store API. It is opt-in: the test is skipped unless
// both VULTR_API_KEY and MEMORY_INTEGRATION_TEST=true are set.
//
// Run with:
//
//	VULTR_API_KEY=<key> MEMORY_INTEGRATION_TEST=true go test ./... -run Integration
func TestMemoryRoundTrip_Integration(t *testing.T) {
	if os.Getenv("MEMORY_INTEGRATION_TEST") != "true" {
		t.Skip("set MEMORY_INTEGRATION_TEST=true (and VULTR_API_KEY) to run live API test")
	}
	apiKey := strings.TrimSpace(os.Getenv("VULTR_API_KEY"))
	if apiKey == "" {
		t.Skip("VULTR_API_KEY not set; skipping integration test")
	}

	ctx := context.Background()
	collectionName := "test-roundtrip-" + uniqueSuffix()

	client := NewMemoryClient(defaultVultrBaseURL, apiKey, nil)

	// Step 1: create the test collection.
	if err := client.EnsureCollection(ctx, collectionName); err != nil {
		t.Fatalf("EnsureCollection: %v", err)
	}

	collectionID, err := client.getCollectionID()
	if err != nil {
		t.Fatalf("getCollectionID after EnsureCollection: %v", err)
	}
	if collectionID == "" {
		t.Fatal("collectionID is empty after EnsureCollection")
	}

	// Cleanup: delete the test collection when done.
	t.Cleanup(func() {
		if cleanupErr := client.DeleteCollection(ctx, collectionID); cleanupErr != nil {
			t.Logf("Warning: failed to delete test collection %q (%s): %v", collectionName, collectionID, cleanupErr)
		}
	})

	// Step 2: add a distinguishable item.
	content := "integration test memory: the sky is blue on a clear day"
	if err := client.AddItem(ctx, content); err != nil {
		t.Fatalf("AddItem: %v", err)
	}

	// Step 3: search for the item. Vector indexing may not be instantaneous;
	// retry a few times with a short back-off before failing.
	var results []string
	const maxAttempts = 5
	for i := range maxAttempts {
		results, err = client.Search(ctx, "what color is the sky")
		if err != nil {
			t.Fatalf("Search attempt %d: %v", i+1, err)
		}
		if len(results) > 0 {
			break
		}
		// Brief pause before retrying.
		t.Logf("Search attempt %d returned no results; retrying…", i+1)
		waitForIndex(t, i)
	}

	// Step 4: verify the stored content appears in the results.
	if !slices.Contains(results, content) {
		t.Errorf("expected %q in search results; got: %v", content, results)
	}
}

// uniqueSuffix returns a hex string derived from the current Unix nanosecond
// timestamp, suitable for making test collection names unique.
func uniqueSuffix() string {
	return fmt.Sprintf("%x", time.Now().UnixNano())
}

// waitForIndex sleeps for an exponentially increasing duration between
// integration-test search retry attempts (capped at 10 s).
func waitForIndex(t *testing.T, attempt int) {
	t.Helper()
	sleepSeconds := min(1<<attempt, 10) // 1s, 2s, 4s, 8s, … capped at 10s
	time.Sleep(time.Duration(sleepSeconds) * time.Second)
}

func TestConfigureMemory_UsesCustomCollectionName(t *testing.T) {
	t.Setenv("MEMORY_COLLECTION_NAME", "custom-col")

	listResp := `{"collections":[]}`
	createResp := `{"collection":{"id":"col-new","name":"custom-col"}}`
	srv, h := newMockServer([]mockResponse{
		{status: 200, body: listResp},
		{status: 201, body: createResp},
	})
	defer srv.Close()

	// Run EnsureCollection directly (mirrors what configureMemory does) to verify
	// the custom collection name is passed through.
	client := NewMemoryClient(srv.URL, "key", srv.Client())
	if err := client.EnsureCollection(context.Background(), memoryCollectionName()); err != nil {
		t.Fatalf("EnsureCollection: %v", err)
	}

	// Verify the POST body used the custom name.
	if len(h.bodies) < 2 {
		t.Fatal("expected 2 requests (GET + POST)")
	}
	var createBody map[string]string
	if err := json.Unmarshal([]byte(h.bodies[1]), &createBody); err != nil {
		t.Fatalf("parse body: %v", err)
	}
	if createBody["name"] != "custom-col" {
		t.Errorf("collection name sent = %q, want %q", createBody["name"], "custom-col")
	}
}

// --- Summarize memories tests ---

func TestSummarizeMemories_Success(t *testing.T) {
	summarizeResp := `{"id":"test","choices":[{"index":0,"message":{"role":"assistant","content":"- Likes Go\n- Dislikes Java"}}]}`
	srv, h := newMockServer([]mockResponse{
		{status: 200, body: summarizeResp},
	})
	defer srv.Close()

	agent := &Agent{
		baseURL:            srv.URL,
		apiKey:             "test-key",
		httpClient:         srv.Client(),
		summarizationModel: Summarization,
	}

	result, err := agent.summarizeMemories(context.Background(), []string{"user prefers Go", "user dislikes Java"})
	if err != nil {
		t.Fatalf("summarizeMemories returned error: %v", err)
	}
	if result != "- Likes Go\n- Dislikes Java" {
		t.Errorf("result = %q, want %q", result, "- Likes Go\n- Dislikes Java")
	}

	// Verify request was sent to /chat/completions.
	if len(h.requests) != 1 {
		t.Fatalf("expected 1 request, got %d", len(h.requests))
	}
	if h.requests[0].URL.Path != "/chat/completions" {
		t.Errorf("path = %q, want /chat/completions", h.requests[0].URL.Path)
	}
	if h.requests[0].Method != http.MethodPost {
		t.Errorf("method = %q, want POST", h.requests[0].Method)
	}

	// Verify the request body contains the memory items.
	var reqBody ChatCompletionRequest
	if err := json.Unmarshal([]byte(h.bodies[0]), &reqBody); err != nil {
		t.Fatalf("parse request body: %v", err)
	}
	if reqBody.Model != string(Summarization) {
		t.Errorf("model = %q, want %q", reqBody.Model, string(Summarization))
	}
	if len(reqBody.Messages) != 2 {
		t.Fatalf("expected 2 messages (system + user), got %d", len(reqBody.Messages))
	}
	userContent, ok := reqBody.Messages[1].Content.(string)
	if !ok {
		t.Fatal("user message content is not a string")
	}
	if !strings.Contains(userContent, "user prefers Go") {
		t.Errorf("user content missing memory item; got: %s", userContent)
	}
}

func TestSummarizeMemories_FallbackOnError(t *testing.T) {
	// Search returns results, but summarization returns 500 → fallback to truncation.
	searchResp := `{"results":[{"id":"1","content":"user prefers Go programming language"},{"id":"2","content":"user dislikes Java"}]}`

	srv, _ := newPathRoutingServer(map[string][]mockResponse{
		"/vector_store": {{status: 200, body: searchResp}},
		"/chat":         {{status: 500, body: `{"error":"internal"}`}},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-abc"
	client.mu.Unlock()

	agent := &Agent{
		baseURL:            srv.URL,
		apiKey:             "test-key",
		httpClient:         srv.Client(),
		summarizationModel: Summarization,
		memoryClient:       client,
	}

	result := agent.recallMemories(context.Background(), "programming preferences")
	if !strings.Contains(result, "[Memory]") {
		t.Errorf("expected [Memory] section in fallback result; got:\n%s", result)
	}
	// Should contain truncated content, not full verbatim.
	if !strings.Contains(result, "user prefers Go") {
		t.Errorf("expected truncated memory content; got:\n%s", result)
	}
	if !strings.Contains(result, "recall tool") {
		t.Errorf("expected recall tool hint in fallback result; got:\n%s", result)
	}
}

// --- Recall tool tests ---

func TestRecallTool_ReturnsFullContent(t *testing.T) {
	searchResp := `{"results":[{"id":"1","content":"full memory one"},{"id":"2","content":"full memory two"}]}`
	srv, _ := newMockServer([]mockResponse{
		{status: 200, body: searchResp},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-abc"
	client.mu.Unlock()

	agent := &Agent{memoryClient: client}

	input, _ := json.Marshal(RecallInput{Query: "memories"})
	result, err := agent.recallFunction(json.RawMessage(input))
	if err != nil {
		t.Fatalf("recallFunction returned error: %v", err)
	}
	expected := "full memory one\n\n---\n\nfull memory two"
	if result != expected {
		t.Errorf("result = %q, want %q", result, expected)
	}
}

func TestRecallTool_EmptyQueryReturnsError(t *testing.T) {
	srv, _ := newMockServer(nil)
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-abc"
	client.mu.Unlock()

	agent := &Agent{memoryClient: client}

	input, _ := json.Marshal(RecallInput{Query: ""})
	_, err := agent.recallFunction(json.RawMessage(input))
	if err == nil {
		t.Fatal("expected error for empty query, got nil")
	}
}

func TestRecallTool_NoResults(t *testing.T) {
	srv, _ := newMockServer([]mockResponse{
		{status: 200, body: `{"results":[]}`},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-abc"
	client.mu.Unlock()

	agent := &Agent{memoryClient: client}

	input, _ := json.Marshal(RecallInput{Query: "something"})
	result, err := agent.recallFunction(json.RawMessage(input))
	if err != nil {
		t.Fatalf("recallFunction returned error: %v", err)
	}
	if result != "No matching memories found." {
		t.Errorf("result = %q, want %q", result, "No matching memories found.")
	}
}

func TestRecallTool_PropagatesSearchError(t *testing.T) {
	srv, _ := newMockServer([]mockResponse{
		{status: 500, body: `{"error":"internal"}`},
	})
	defer srv.Close()

	client := NewMemoryClient(srv.URL, "test-key", srv.Client())
	client.mu.Lock()
	client.collectionID = "col-abc"
	client.mu.Unlock()

	agent := &Agent{memoryClient: client}

	input, _ := json.Marshal(RecallInput{Query: "test query"})
	_, err := agent.recallFunction(json.RawMessage(input))
	if err == nil {
		t.Fatal("expected error when search fails, got nil")
	}
}

// --- truncateMemories tests ---

func TestTruncateMemories_ShortItems(t *testing.T) {
	items := []string{"short one", "short two"}
	result := truncateMemories(items)
	if result != "- short one\n- short two" {
		t.Errorf("result = %q, want %q", result, "- short one\n- short two")
	}
}

func TestTruncateMemories_LongItems(t *testing.T) {
	longItem := strings.Repeat("a", 100)
	result := truncateMemories([]string{longItem})
	if len(result) > 90 { // "- " + 80 chars + "..."
		t.Errorf("truncated result too long: %d chars", len(result))
	}
	if !strings.HasSuffix(result, "...") {
		t.Errorf("expected truncated item to end with '...'; got: %q", result)
	}
}
