package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// MemoryClient provides access to the Vultr managed vector store API for
// durable semantic memory. A single collection is used; the collection ID is
// resolved once via EnsureCollection and cached for subsequent operations.
type MemoryClient struct {
	baseURL      string
	apiKey       string
	httpClient   *http.Client
	collectionID string
	mu           sync.RWMutex
}

// NewMemoryClient creates a MemoryClient pointed at the given base URL.
// baseURL should be the vector store root (e.g. "https://api.vultrinference.com"),
// without a trailing slash. If httpClient is nil, http.DefaultClient is used.
func NewMemoryClient(baseURL, apiKey string, httpClient *http.Client) *MemoryClient {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &MemoryClient{
		baseURL:    baseURL,
		apiKey:     apiKey,
		httpClient: httpClient,
	}
}

// --- API response types ---

type vsCollection struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type vsListCollectionsResponse struct {
	Collections []vsCollection `json:"collections"`
}

// MemoryItem is a single stored item returned by ListItems.
// The API returns "description" for list-items but "content" for search results,
// so both fields are mapped and Content() resolves the effective value.
type MemoryItem struct {
	ID          string `json:"id"`
	ItemContent string `json:"content,omitempty"`
	Description string `json:"description,omitempty"`
	Created     string `json:"created,omitempty"`
}

// Content returns the effective text of the memory item, preferring the content
// field (returned by search) over description (returned by list-items).
func (m MemoryItem) Content() string {
	if m.ItemContent != "" {
		return m.ItemContent
	}
	return m.Description
}

type vsListItemsResponse struct {
	Items []MemoryItem `json:"items"`
}

type vsSearchResult struct {
	ID      string `json:"id"`
	Content string `json:"content"`
	Created string `json:"created,omitempty"`
}

type vsSearchResponse struct {
	Results []vsSearchResult `json:"results"`
}

// SearchResult is a single memory item returned by Search, containing the
// verbatim content and the timestamp at which it was stored.
type SearchResult struct {
	Content string
	Created time.Time
}

// relativeAge returns a human-readable description of how long ago t was
// relative to now. Returns "" if t is zero (graceful degradation when the
// API omits the timestamp).
func relativeAge(t, now time.Time) string {
	if t.IsZero() {
		return ""
	}
	d := now.Sub(t)
	if d < 0 {
		return ""
	}
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		m := int(d.Minutes())
		if m == 1 {
			return "1 minute ago"
		}
		return fmt.Sprintf("%d minutes ago", m)
	case d < 24*time.Hour:
		h := int(d.Hours())
		if h == 1 {
			return "1 hour ago"
		}
		return fmt.Sprintf("%d hours ago", h)
	case d < 7*24*time.Hour:
		days := int(d.Hours() / 24)
		if days == 1 {
			return "1 day ago"
		}
		return fmt.Sprintf("%d days ago", days)
	case d < 30*24*time.Hour:
		weeks := int(d.Hours() / (24 * 7))
		if weeks == 1 {
			return "1 week ago"
		}
		return fmt.Sprintf("%d weeks ago", weeks)
	case d < 365*24*time.Hour:
		months := int(d.Hours() / (24 * 30))
		if months == 1 {
			return "1 month ago"
		}
		return fmt.Sprintf("%d months ago", months)
	default:
		years := int(d.Hours() / (24 * 365))
		if years == 1 {
			return "1 year ago"
		}
		return fmt.Sprintf("%d years ago", years)
	}
}

// --- HTTP helpers ---

// doRequest executes a request against the vector store API.
// body is JSON-marshalled when non-nil. Returns the response body, HTTP status
// code, and any transport-level error.
func (m *MemoryClient) doRequest(ctx context.Context, method, path string, body interface{}) ([]byte, int, error) {
	var bodyReader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, 0, fmt.Errorf("memory client: marshal request body: %w", err)
		}
		bodyReader = bytes.NewReader(b)
	}

	req, err := http.NewRequestWithContext(ctx, method, m.baseURL+path, bodyReader)
	if err != nil {
		return nil, 0, fmt.Errorf("memory client: create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+m.apiKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := m.httpClient.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("memory client: do request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("memory client: read response: %w", err)
	}
	return respBody, resp.StatusCode, nil
}

func (m *MemoryClient) getCollectionID() (string, error) {
	m.mu.RLock()
	id := m.collectionID
	m.mu.RUnlock()
	if id == "" {
		return "", fmt.Errorf("memory client: collection not initialized; call EnsureCollection first")
	}
	return id, nil
}

// --- Collection management ---

// EnsureCollection resolves or creates a vector store collection by name.
// On success it caches the collection ID for use in subsequent calls.
// Calling EnsureCollection again will re-check the remote list (idempotent).
func (m *MemoryClient) EnsureCollection(ctx context.Context, name string) error {
	respBody, status, err := m.doRequest(ctx, http.MethodGet, "/vector_store", nil)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("memory client: list collections: status %d: %s", status, string(respBody))
	}

	var list vsListCollectionsResponse
	if err := json.Unmarshal(respBody, &list); err != nil {
		return fmt.Errorf("memory client: parse collections list: %w", err)
	}

	for _, col := range list.Collections {
		if col.Name == name {
			m.mu.Lock()
			m.collectionID = col.ID
			m.mu.Unlock()
			return nil
		}
	}

	// Collection not found; create it.
	createReqBody := map[string]string{"name": name}
	createResp, createStatus, err := m.doRequest(ctx, http.MethodPost, "/vector_store", createReqBody)
	if err != nil {
		return err
	}
	if createStatus < 200 || createStatus >= 300 {
		return fmt.Errorf("memory client: create collection: status %d: %s", createStatus, string(createResp))
	}

	var created struct {
		Collection vsCollection `json:"collection"`
	}
	if err := json.Unmarshal(createResp, &created); err != nil {
		return fmt.Errorf("memory client: parse created collection: %w", err)
	}
	if created.Collection.ID == "" {
		return fmt.Errorf("memory client: created collection has no ID")
	}

	m.mu.Lock()
	m.collectionID = created.Collection.ID
	m.mu.Unlock()
	return nil
}

// --- Item operations ---

// AddItem stores a text string as a new item in the memory collection.
// EnsureCollection must be called before AddItem.
func (m *MemoryClient) AddItem(ctx context.Context, content string) error {
	id, err := m.getCollectionID()
	if err != nil {
		return err
	}

	body := map[string]string{"content": content, "description": "memory"}
	respBody, status, err := m.doRequest(ctx, http.MethodPost, "/vector_store/"+id+"/items", body)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("memory client: add item: status %d: %s", status, string(respBody))
	}
	return nil
}

// Search performs a semantic similarity search against the memory collection
// and returns the matching items with their content and creation timestamps.
// EnsureCollection must be called before Search.
func (m *MemoryClient) Search(ctx context.Context, query string) ([]SearchResult, error) {
	id, err := m.getCollectionID()
	if err != nil {
		return nil, err
	}

	body := map[string]string{"input": query}
	respBody, status, err := m.doRequest(ctx, http.MethodPost, "/vector_store/"+id+"/search", body)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("memory client: search: status %d: %s", status, string(respBody))
	}

	var result vsSearchResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("memory client: parse search results: %w", err)
	}

	items := make([]SearchResult, 0, len(result.Results))
	for _, r := range result.Results {
		if r.Content != "" {
			sr := SearchResult{Content: r.Content}
			if r.Created != "" {
				sr.Created, _ = time.Parse(time.RFC3339, r.Created)
			}
			items = append(items, sr)
		}
	}
	return items, nil
}

// ListItems returns all items stored in the memory collection.
// Intended for diagnostics and maintenance.
// EnsureCollection must be called before ListItems.
func (m *MemoryClient) ListItems(ctx context.Context) ([]MemoryItem, error) {
	id, err := m.getCollectionID()
	if err != nil {
		return nil, err
	}

	respBody, status, err := m.doRequest(ctx, http.MethodGet, "/vector_store/"+id+"/items", nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("memory client: list items: status %d: %s", status, string(respBody))
	}

	var list vsListItemsResponse
	if err := json.Unmarshal(respBody, &list); err != nil {
		return nil, fmt.Errorf("memory client: parse items list: %w", err)
	}
	return list.Items, nil
}

// DeleteCollection removes the entire vector store collection by ID.
// This is a destructive operation intended for test cleanup; it does not
// require EnsureCollection to have been called first.
func (m *MemoryClient) DeleteCollection(ctx context.Context, collectionID string) error {
	if collectionID == "" {
		return fmt.Errorf("memory client: collectionID is required for DeleteCollection")
	}
	respBody, status, err := m.doRequest(ctx, http.MethodDelete, "/vector_store/"+collectionID, nil)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("memory client: delete collection: status %d: %s", status, string(respBody))
	}
	return nil
}

// DeleteItem removes a single item from the memory collection by its ID.
// Intended for diagnostics and maintenance.
// EnsureCollection must be called before DeleteItem.
func (m *MemoryClient) DeleteItem(ctx context.Context, itemID string) error {
	id, err := m.getCollectionID()
	if err != nil {
		return err
	}

	respBody, status, err := m.doRequest(ctx, http.MethodDelete, "/vector_store/"+id+"/items/"+itemID, nil)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("memory client: delete item: status %d: %s", status, string(respBody))
	}
	return nil
}

// --- Auto-recall ---

const (
	summarizationTimeout  = 15 * time.Second
	summarizationMaxTokens = 256
	recallMaxSearchResults = 10
	recallTruncateLen      = 80
)

// summarizeMemories makes a direct HTTP POST to the chat completions endpoint,
// completely bypassing runInferenceWithModel/withSystemPrompt to avoid infinite
// recursion. It returns a compact summary of the provided memory items.
func (a *Agent) summarizeMemories(ctx context.Context, items []string) (string, error) {
	timeoutCtx, cancel := context.WithTimeout(ctx, summarizationTimeout)
	defer cancel()

	userContent := strings.Join(items, "\n---\n")
	reqBody := ChatCompletionRequest{
		Model:     string(a.summarizationModel),
		MaxTokens: summarizationMaxTokens,
		Messages: []ChatMessage{
			{
				Role:    "system",
				Content: "Summarize the following memory items into a compact bullet list. Each bullet should capture the key fact. Be concise.",
			},
			{
				Role:    "user",
				Content: userContent,
			},
		},
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("summarize memories: marshal: %w", err)
	}

	req, err := http.NewRequestWithContext(timeoutCtx, http.MethodPost, a.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("summarize memories: create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+a.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := a.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("summarize memories: request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("summarize memories: read response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("summarize memories: status %d: %s", resp.StatusCode, string(respBody))
	}

	var completion ChatCompletionResponse
	if err := json.Unmarshal(respBody, &completion); err != nil {
		return "", fmt.Errorf("summarize memories: parse response: %w", err)
	}
	if completion.Error != nil && completion.Error.Message != "" {
		return "", fmt.Errorf("summarize memories: api error: %s", completion.Error.Message)
	}
	if len(completion.Choices) == 0 {
		return "", fmt.Errorf("summarize memories: no choices returned")
	}

	content, ok := completion.Choices[0].Message.Content.(string)
	if !ok || strings.TrimSpace(content) == "" {
		return "", fmt.Errorf("summarize memories: empty content")
	}
	return strings.TrimSpace(content), nil
}

// truncateMemories returns a bullet list where each item is truncated to
// recallTruncateLen characters. Used as a fallback when summarization fails.
func truncateMemories(items []string) string {
	var b strings.Builder
	for i, item := range items {
		if i > 0 {
			b.WriteByte('\n')
		}
		trimmed := strings.TrimSpace(item)
		if len(trimmed) > recallTruncateLen {
			trimmed = trimmed[:recallTruncateLen] + "..."
		}
		b.WriteString("- ")
		b.WriteString(trimmed)
	}
	return b.String()
}

// recallMemories performs a semantic search against the memory store using
// the given query and returns a formatted [Memory] section string suitable for
// appending to a system prompt. The raw results are summarized by an LLM; on
// summarization failure it falls back to programmatic truncation. Returns an
// empty string on error, when no memories are found, or when memoryClient is nil.
func (a *Agent) recallMemories(ctx context.Context, query string) string {
	if a.memoryClient == nil || strings.TrimSpace(query) == "" {
		return ""
	}
	results, err := a.memoryClient.Search(ctx, query)
	if err != nil || len(results) == 0 {
		return ""
	}

	// Cap search results to bound summarization input size.
	if len(results) > recallMaxSearchResults {
		results = results[:recallMaxSearchResults]
	}

	// Extract plain content strings for summarization (no age annotations).
	contents := make([]string, len(results))
	for i, r := range results {
		contents[i] = r.Content
	}

	summary, err := a.summarizeMemories(ctx, contents)
	if err != nil {
		// Fallback: programmatic truncation.
		summary = truncateMemories(contents)
	}

	body := summary + "\nUse the recall tool with a targeted query to retrieve full details."
	return formatSection("Memory", body)
}

// --- Record tool ---

// RecordInput is the input schema for the `record` tool.
type RecordInput struct {
	Subject     string `json:"subject" jsonschema_description:"The entity this fact is about. Use a short, recognizable name: @-handle for users ('@henry'), project name ('agent project'), tool name ('Postgres'), or descriptive label ('team standup'). Keep it stable across calls so related facts cluster together."`
	SubjectType string `json:"subject_type" jsonschema_description:"Category of the subject. Use a short lowercase label: 'discord user', 'person', 'codebase', 'project', 'tool', 'service', 'team', 'recurring meeting', etc. Pick the most specific label that fits."`
	Descriptor  string `json:"descriptor" jsonschema_description:"A verb-phrase predicate stating the fact. Must start with a verb: 'is a Cubs fan', 'prefers dark mode', 'uses Go and Rust', 'happens every Tuesday at 9am'. Write it so that '<subject_type> <subject> <descriptor>' reads as a complete sentence."`
}

var RecordInputSchema = GenerateSchema[RecordInput]()

// formatMemoryContent concatenates the structured triple into a natural-language
// sentence for storage: "<subject_type> <subject> <descriptor>".
func formatMemoryContent(subjectType, subject, descriptor string) string {
	return strings.TrimSpace(subjectType) + " " + strings.TrimSpace(subject) + " " + strings.TrimSpace(descriptor)
}

// recordToolDefinition returns the ToolDefinition for the `record` tool.
func (a *Agent) recordToolDefinition() ToolDefinition {
	return ToolDefinition{
		Name:        "record",
		Description: "Store exactly one atomic fact for future recall. Provide:\n\nsubject: the single, most specific noun phrase (e.g. @henry, cookbook app, Postgres)\nsubject_type: a lowercase, singular label (e.g. discord user, project, tool)\ndescriptor: a present-tense verb phrase starting with a verb (e.g. is a Cubs fan, releases every Thursday)\n\nThe system will automatically assemble them into the sentence \"<subject_type> <subject> <descriptor>\". Don't duplicate the type or subject in the descriptor.",
		InputSchema: RecordInputSchema,
		Function:    a.recordFunction,
		Async:       true,
	}
}

// --- Recall tool ---

// RecallInput is the input schema for the `recall` tool.
type RecallInput struct {
	Query string `json:"query" jsonschema_description:"A targeted search query to find specific memories. Be specific to get the most relevant results."`
}

var RecallInputSchema = GenerateSchema[RecallInput]()

// recallToolDefinition returns the ToolDefinition for the `recall` tool.
func (a *Agent) recallToolDefinition() ToolDefinition {
	return ToolDefinition{
		Name:        "recall",
		Description: "Search long-term memories using natural-language queries. Describe what you're looking for—concepts, relationships, or phrases—and the system will semantically match against stored facts. Results are returned in order of relevance, most-relevant first, with a human-readable age appended to each fact. Stored facts follow the sentence structure \"<subject_type> <subject> <descriptor>\" (e.g. \"discord user @henry is a Cubs fan\", \"project cookbook app releases every Thursday\").",
		InputSchema: RecallInputSchema,
		Function:    a.recallFunction,
	}
}

// recallFunction is the execution handler for the `recall` tool.
// It performs a semantic search and returns full verbatim results, each
// annotated with a human-readable storage age when a timestamp is available.
func (a *Agent) recallFunction(input json.RawMessage) (string, error) {
	var payload RecallInput
	if err := json.Unmarshal(input, &payload); err != nil {
		return "", err
	}
	if strings.TrimSpace(payload.Query) == "" {
		return "", fmt.Errorf("query is required")
	}
	results, err := a.memoryClient.Search(context.Background(), payload.Query)
	if err != nil {
		return "", fmt.Errorf("failed to search memory: %w", err)
	}
	if len(results) == 0 {
		return "No matching memories found.", nil
	}
	now := time.Now()
	parts := make([]string, len(results))
	for i, r := range results {
		age := relativeAge(r.Created, now)
		if age != "" {
			parts[i] = r.Content + " (stored " + age + ")"
		} else {
			parts[i] = r.Content
		}
	}
	return strings.Join(parts, "\n\n---\n\n"), nil
}

// --- Agent wiring ---

const defaultMemoryCollectionName = "agent-memory"

// configureMemory reads MEMORY_ENABLED and MEMORY_COLLECTION_NAME from the
// environment, creates a MemoryClient, calls EnsureCollection, sets
// agent.memoryClient, and rebuilds agent.tools so the record and recall tools
// are included. On any failure it logs a warning to stderr and leaves
// agent.memoryClient nil (graceful degradation). No error is returned; the agent
// continues without memory.
func configureMemory(ctx context.Context, agent *Agent) {
	if isMemoryDisabled() {
		return
	}
	collectionName := memoryCollectionName()
	client := NewMemoryClient(agent.baseURL, agent.apiKey, agent.httpClient)
	if err := client.EnsureCollection(ctx, collectionName); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: memory initialization failed, running without memory: %v\n", err)
		return
	}
	agent.memoryClient = client
	agent.tools = agent.buildTools(nil)
}

// isMemoryDisabled reports whether the MEMORY_ENABLED env var has been set to a
// falsy value ("false", "0", or "no"). Memory is enabled by default.
func isMemoryDisabled() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("MEMORY_ENABLED")))
	return v == "false" || v == "0" || v == "no"
}

// memoryCollectionName returns the collection name from MEMORY_COLLECTION_NAME,
// falling back to defaultMemoryCollectionName when the env var is unset or empty.
func memoryCollectionName() string {
	if name := strings.TrimSpace(os.Getenv("MEMORY_COLLECTION_NAME")); name != "" {
		return name
	}
	return defaultMemoryCollectionName
}

// recordFunction is the execution handler for the `record` tool.
// It validates the structured triple and stores the concatenated sentence
// in the memory collection via AddItem.
func (a *Agent) recordFunction(input json.RawMessage) (string, error) {
	var payload RecordInput
	if err := json.Unmarshal(input, &payload); err != nil {
		return "", err
	}
	if strings.TrimSpace(payload.Subject) == "" {
		return "", fmt.Errorf("subject is required")
	}
	if strings.TrimSpace(payload.SubjectType) == "" {
		return "", fmt.Errorf("subject_type is required")
	}
	if strings.TrimSpace(payload.Descriptor) == "" {
		return "", fmt.Errorf("descriptor is required")
	}
	content := formatMemoryContent(payload.SubjectType, payload.Subject, payload.Descriptor)
	if err := a.memoryClient.AddItem(context.Background(), content); err != nil {
		return "", fmt.Errorf("failed to store memory: %w", err)
	}
	return "Memory stored.", nil
}
