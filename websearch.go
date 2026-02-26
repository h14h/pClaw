package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	defaultTavilyBaseURL      = "https://api.tavily.com"
	defaultWebSearchMaxResults = 5
	webSearchTimeout           = 30 * time.Second
)

// WebSearchClient provides access to the Tavily Search API for web grounding.
type WebSearchClient struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
	maxResults int
}

// NewWebSearchClient creates a WebSearchClient pointed at the given base URL.
// If httpClient is nil, http.DefaultClient is used. If maxResults is <= 0,
// defaultWebSearchMaxResults is used.
func NewWebSearchClient(baseURL, apiKey string, httpClient *http.Client, maxResults int) *WebSearchClient {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	if maxResults <= 0 {
		maxResults = defaultWebSearchMaxResults
	}
	return &WebSearchClient{
		baseURL:    baseURL,
		apiKey:     apiKey,
		httpClient: httpClient,
		maxResults: maxResults,
	}
}

// --- Tavily API types ---

type tavilySearchRequest struct {
	Query         string `json:"query"`
	SearchDepth   string `json:"search_depth,omitempty"`
	Topic         string `json:"topic,omitempty"`
	MaxResults    int    `json:"max_results,omitempty"`
	IncludeAnswer bool   `json:"include_answer"`
}

type tavilySearchResult struct {
	Title   string  `json:"title"`
	URL     string  `json:"url"`
	Content string  `json:"content"`
	Score   float64 `json:"score"`
}

type tavilySearchResponse struct {
	Query        string               `json:"query"`
	Answer       string               `json:"answer,omitempty"`
	Results      []tavilySearchResult `json:"results"`
	ResponseTime float64              `json:"response_time"`
}

// WebSearchResult is the structured output returned by Search.
type WebSearchResult struct {
	Answer  string
	Sources []WebSearchSource
}

// WebSearchSource is a single source from a web search.
type WebSearchSource struct {
	Title   string
	URL     string
	Content string
	Score   float64
}

// Search performs a web search via the Tavily API and returns the answer
// and source results.
func (c *WebSearchClient) Search(ctx context.Context, query, topic, searchDepth string) (*WebSearchResult, error) {
	timeoutCtx, cancel := context.WithTimeout(ctx, webSearchTimeout)
	defer cancel()

	reqBody := tavilySearchRequest{
		Query:         query,
		MaxResults:    c.maxResults,
		IncludeAnswer: true,
	}
	switch strings.TrimSpace(topic) {
	case "general", "news", "finance":
		reqBody.Topic = strings.TrimSpace(topic)
	}
	switch strings.TrimSpace(searchDepth) {
	case "basic", "advanced":
		reqBody.SearchDepth = strings.TrimSpace(searchDepth)
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("web search: marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(timeoutCtx, http.MethodPost, c.baseURL+"/search", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("web search: create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("web search: request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("web search: read response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("web search: status %d: %s", resp.StatusCode, string(respBody))
	}

	var result tavilySearchResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("web search: parse response: %w", err)
	}

	out := &WebSearchResult{
		Answer: strings.TrimSpace(result.Answer),
	}
	for _, r := range result.Results {
		out.Sources = append(out.Sources, WebSearchSource{
			Title:   r.Title,
			URL:     r.URL,
			Content: r.Content,
			Score:   r.Score,
		})
	}
	return out, nil
}

// --- web_search tool ---

// WebSearchInput is the input schema for the `web_search` tool.
type WebSearchInput struct {
	Query       string `json:"query" jsonschema_description:"The search query. Be specific and include key terms for best results."`
	Topic       string `json:"topic,omitempty" jsonschema_description:"Search category: 'general' (default), 'news', or 'finance'. Use 'news' for current events and 'finance' for market/financial data."`
	SearchDepth string `json:"search_depth,omitempty" jsonschema_description:"Search depth: 'basic' (default, 1 credit) or 'advanced' (2 credits, higher quality). Use 'advanced' only when basic results are insufficient."`
}

var WebSearchInputSchema = GenerateSchema[WebSearchInput]()

// webSearchToolDefinition returns the ToolDefinition for the `web_search` tool.
func (a *Agent) webSearchToolDefinition() ToolDefinition {
	return ToolDefinition{
		Name:        "web_search",
		Description: "Search the web for current, factual information. Use this tool to verify claims, look up recent events, find technical documentation, or get any information that requires up-to-date web sources. Returns an answer summary plus individual source results with URLs.",
		InputSchema: WebSearchInputSchema,
		Function:    a.webSearchFunction,
	}
}

// webSearchFunction is the execution handler for the `web_search` tool.
func (a *Agent) webSearchFunction(input json.RawMessage) (string, error) {
	var payload WebSearchInput
	if err := json.Unmarshal(input, &payload); err != nil {
		return "", err
	}
	if strings.TrimSpace(payload.Query) == "" {
		return "", fmt.Errorf("query is required")
	}

	result, err := a.webSearchClient.Search(context.Background(), payload.Query, payload.Topic, payload.SearchDepth)
	if err != nil {
		return "", fmt.Errorf("web search failed: %w", err)
	}

	return formatWebSearchResult(result), nil
}

// formatWebSearchResult renders a WebSearchResult as a string suitable for
// returning to the model. Includes the answer (if present) and numbered sources.
func formatWebSearchResult(result *WebSearchResult) string {
	if result == nil {
		return "No results found."
	}

	var b strings.Builder

	if result.Answer != "" {
		b.WriteString("Answer: ")
		b.WriteString(result.Answer)
		b.WriteString("\n\n")
	}

	if len(result.Sources) == 0 {
		if result.Answer == "" {
			return "No results found."
		}
		return b.String()
	}

	b.WriteString("Sources:\n")
	for i, src := range result.Sources {
		fmt.Fprintf(&b, "%d. %s (%s)", i+1, src.Title, src.URL)
		if src.Content != "" {
			b.WriteString("\n   ")
			b.WriteString(src.Content)
		}
		if i < len(result.Sources)-1 {
			b.WriteByte('\n')
		}
	}

	return b.String()
}

// --- Agent wiring ---

// configureWebSearch reads TAVILY_API_KEY from the environment, creates a
// WebSearchClient, sets agent.webSearchClient, and rebuilds agent.tools so the
// web_search tool is included. When TAVILY_API_KEY is unset or empty, the agent
// starts without web search (graceful degradation).
func configureWebSearch(agent *Agent) {
	apiKey := strings.TrimSpace(os.Getenv("TAVILY_API_KEY"))
	if apiKey == "" {
		return
	}

	maxResults := defaultWebSearchMaxResults
	if raw := strings.TrimSpace(os.Getenv("WEB_SEARCH_MAX_RESULTS")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 20 {
			maxResults = n
		} else {
			fmt.Fprintf(os.Stderr, "Warning: invalid WEB_SEARCH_MAX_RESULTS=%q; defaulting to %d\n", raw, defaultWebSearchMaxResults)
		}
	}

	client := NewWebSearchClient(defaultTavilyBaseURL, apiKey, agent.httpClient, maxResults)
	agent.webSearchClient = client
	agent.tools = agent.buildTools(nil)
}
