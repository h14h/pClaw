package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/invopop/jsonschema"
)

const (
	defaultVultrBaseURL = "https://api.vultrinference.com/v1"
	defaultReasoningLimit = 2
	reasoningCallTimeout  = 45 * time.Second
	reasoningMaxTokens    = 16384
	primaryMaxTokens      = 4096
	statusDelay           = 150 * time.Millisecond
	statusFrameInterval   = 100 * time.Millisecond
	toolStatusDelay       = 200 * time.Millisecond
)

type Model string

const (
	Instruct      Model = "kimi-k2-instruct"
	Reasoning     Model = "gpt-oss-120b"
	Summarization Model = "qwen2.5-coder-32b-instruct" // memory recall summarization
)

type ToolEventLogMode string

const (
	ToolEventLogOff   ToolEventLogMode = "off"
	ToolEventLogDebug ToolEventLogMode = "debug"
)

type ToolDefinition struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	InputSchema map[string]interface{} `json:"input_schema"`
	Function    func(input json.RawMessage) (string, error)
	Async       bool
}

type Agent struct {
	baseURL             string
	apiKey              string
	primaryModel        Model
	reasoningModel      Model
	summarizationModel  Model
	promptBuilder       PromptBuilder
	promptTransport     string
	httpClient          *http.Client
	getUserMessage      func() (string, bool)
	tools               []ToolDefinition
	toolEventSink       ToolEventSink
	serverEventSink     ServerEventSink
	outputWriter        io.Writer
	reasoningCallCount  int
	memoryClient        *MemoryClient
	recallTurnCache     *recallCache
	webSearchClient     *WebSearchClient
	sandbox             *Sandbox
	asyncWg             sync.WaitGroup

	// Thinking toggle: when thinkingToggleKeypath is non-empty, inference
	// requests inject a nested field to control per-request thinking.
	thinkingToggleKeypath  []string
	thinkingToggleOnValue  interface{}
	thinkingToggleOffValue interface{}
}

// Sandbox constrains filesystem tool access to a single directory tree.
type Sandbox struct {
	root string
}

// defaultWorkingDirectory returns the default sandbox root:
// $XDG_DATA_HOME/pclaw/workspace, falling back to ~/.local/share/pclaw/workspace.
func defaultWorkingDirectory() (string, error) {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("cannot determine home directory: %w", err)
		}
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "pclaw", "workspace"), nil
}

// NewSandbox creates a Sandbox rooted at root. When root is empty, it defaults
// to defaultWorkingDirectory() and creates the directory if it doesn't exist.
// When root is non-empty, it resolves to an absolute path and validates it's a directory.
func NewSandbox(root string) (*Sandbox, error) {
	if root == "" {
		var err error
		root, err = defaultWorkingDirectory()
		if err != nil {
			return nil, err
		}
		if err := os.MkdirAll(root, 0o755); err != nil {
			return nil, fmt.Errorf("create workspace directory %s: %w", root, err)
		}
	} else {
		root = expandTilde(root)
		abs, err := filepath.Abs(root)
		if err != nil {
			return nil, fmt.Errorf("resolve working directory %s: %w", root, err)
		}
		root = abs
		info, err := os.Stat(root)
		if err != nil {
			return nil, fmt.Errorf("working directory %s: %w", root, err)
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("working directory %s is not a directory", root)
		}
	}
	return &Sandbox{root: root}, nil
}

// Resolve resolves userPath relative to the sandbox root and validates that
// the resolved path is contained within the sandbox. Relative paths are joined
// with the root. Absolute paths are cleaned. Symlinks are evaluated to prevent
// escapes. For non-existent files (e.g. edit_file create path), the parent
// directory is validated instead.
func (s *Sandbox) Resolve(userPath string) (string, error) {
	if userPath == "" {
		return s.root, nil
	}

	var joined string
	if filepath.IsAbs(userPath) {
		joined = filepath.Clean(userPath)
	} else {
		joined = filepath.Join(s.root, userPath)
	}

	// Try to resolve symlinks on the full path first.
	resolved, err := filepath.EvalSymlinks(joined)
	if err != nil {
		// Path doesn't exist — walk up to find the nearest existing ancestor
		// and validate it's inside the sandbox. This supports edit_file
		// creating new files in new subdirectories.
		candidate := joined
		for {
			parent := filepath.Dir(candidate)
			if parent == candidate {
				// Reached filesystem root without finding an existing ancestor.
				return "", fmt.Errorf("path %q: no existing ancestor found", userPath)
			}
			resolvedParent, perr := filepath.EvalSymlinks(parent)
			if perr != nil {
				candidate = parent
				continue
			}
			if !s.contains(resolvedParent) {
				return "", fmt.Errorf("path %q resolves outside sandbox %s", userPath, s.root)
			}
			// Ancestor is valid and inside sandbox; return the cleaned joined path.
			return joined, nil
		}
	}

	if !s.contains(resolved) {
		return "", fmt.Errorf("path %q resolves outside sandbox %s", userPath, s.root)
	}
	return resolved, nil
}

// Root returns the absolute sandbox root path.
func (s *Sandbox) Root() string {
	return s.root
}

// contains checks whether resolved is equal to or under the sandbox root.
func (s *Sandbox) contains(resolved string) bool {
	return resolved == s.root || strings.HasPrefix(resolved, s.root+string(filepath.Separator))
}

type ServerEventLogMode string

const (
	ServerEventLogOff     ServerEventLogMode = "off"
	ServerEventLogLine    ServerEventLogMode = "line"
	ServerEventLogVerbose ServerEventLogMode = "verbose"
)

type ServerLogLevel string

const (
	ServerLogLevelInfo  ServerLogLevel = "INFO"
	ServerLogLevelWarn  ServerLogLevel = "WARN"
	ServerLogLevelError ServerLogLevel = "ERROR"
)

type ServerEvent struct {
	TS            time.Time
	Level         ServerLogLevel
	Event         string
	Message       string
	TraceID       string
	TurnID        string
	SessionKey    string
	Source        string
	ChannelID     string
	UserIDHash    string
	MessageID     string
	InteractionID string
	Fields        map[string]interface{}
}

type ServerEventSink interface {
	HandleServerEvent(ctx context.Context, event ServerEvent)
}

type LineServerEventSink struct {
	out            io.Writer
	mu             sync.Mutex
	verboseContent bool
}

func (s *LineServerEventSink) HandleServerEvent(_ context.Context, event ServerEvent) {
	out := s.out
	if out == nil {
		out = os.Stdout
	}
	if event.TS.IsZero() {
		event.TS = time.Now().UTC()
	}
	if event.Level == "" {
		event.Level = ServerLogLevelInfo
	}

	parts := []string{
		event.TS.UTC().Format(time.RFC3339Nano),
		string(event.Level),
		"event=" + formatLogValue(event.Event),
	}

	// In line mode (non-verbose), only emit the tool name and error fields.
	// All other metadata and fields are verbose-only.
	if !s.verboseContent {
		if tool, ok := event.Fields["tool"]; ok {
			parts = append(parts, "tool="+formatLogValue(tool))
		}
		if errVal, ok := event.Fields["error"]; ok {
			parts = append(parts, "error="+formatLogValue(errVal))
		}
	} else {
		if event.TraceID != "" {
			parts = append(parts, "trace="+formatLogValue(event.TraceID))
		}
		if event.TurnID != "" {
			parts = append(parts, "turn="+formatLogValue(event.TurnID))
		}
		if event.SessionKey != "" {
			parts = append(parts, "session="+formatLogValue(event.SessionKey))
		}
		if event.Message != "" {
			parts = append(parts, "msg="+formatLogValue(event.Message))
		}
		if event.Source != "" {
			parts = append(parts, "source="+formatLogValue(event.Source))
		}
		if event.ChannelID != "" {
			parts = append(parts, "channel="+formatLogValue(event.ChannelID))
		}
		if event.UserIDHash != "" {
			parts = append(parts, "user="+formatLogValue(event.UserIDHash))
		}
		if event.MessageID != "" {
			parts = append(parts, "message_id="+formatLogValue(event.MessageID))
		}
		if event.InteractionID != "" {
			parts = append(parts, "interaction_id="+formatLogValue(event.InteractionID))
		}
		if len(event.Fields) > 0 {
			keys := make([]string, 0, len(event.Fields))
			for k := range event.Fields {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				parts = append(parts, k+"="+formatLogValue(event.Fields[k]))
			}
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	fmt.Fprintln(out, strings.Join(parts, " "))
}

func formatLogValue(v interface{}) string {
	switch value := v.(type) {
	case nil:
		return `""`
	case string:
		return quoteIfNeeded(value)
	case bool:
		if value {
			return "true"
		}
		return "false"
	case int:
		return strconv.Itoa(value)
	case int64:
		return strconv.FormatInt(value, 10)
	case float64:
		return strconv.FormatFloat(value, 'f', -1, 64)
	default:
		return quoteIfNeeded(fmt.Sprint(value))
	}
}

func quoteIfNeeded(s string) string {
	if s == "" {
		return `""`
	}
	if strings.ContainsAny(s, " \t\n\r\"=") {
		return strconv.Quote(s)
	}
	return s
}

type serverLogMeta struct {
	TraceID       string
	TurnID        string
	SessionKey    string
	Source        string
	ChannelID     string
	UserIDHash    string
	MessageID     string
	InteractionID string
}

type serverLogContextKey struct{}

var serverEventIDCounter uint64

func withServerLogMeta(ctx context.Context, meta serverLogMeta) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, serverLogContextKey{}, meta)
}

func serverLogMetaFromContext(ctx context.Context) serverLogMeta {
	if ctx == nil {
		return serverLogMeta{}
	}
	meta, _ := ctx.Value(serverLogContextKey{}).(serverLogMeta)
	return meta
}

func nextServerEventID(prefix string) string {
	n := atomic.AddUint64(&serverEventIDCounter, 1)
	return fmt.Sprintf("%s_%d_%d", prefix, time.Now().UTC().UnixNano(), n)
}

func hashIdentifier(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(trimmed))
	return "sha256:" + hex.EncodeToString(sum[:8])
}

type ToolEventType string

const (
	ToolEventStarted   ToolEventType = "tool_call.started"
	ToolEventSucceeded ToolEventType = "tool_call.succeeded"
	ToolEventFailed    ToolEventType = "tool_call.failed"
)

type ToolEvent struct {
	Type       ToolEventType
	ToolCallID string
	ToolName   string
	ArgsRaw    string
	ArgsParsed map[string]interface{}
	Stats      map[string]interface{}
	ResultRaw  string
	Err        string
	StartedAt  time.Time
	Duration   time.Duration
}

type ToolEventSink interface {
	HandleToolEvent(ctx context.Context, event ToolEvent)
}

type CLIToolEventSink struct {
	out io.Writer
}

func (s *CLIToolEventSink) HandleToolEvent(_ context.Context, event ToolEvent) {
	out := s.out
	if out == nil {
		out = os.Stdout
	}
	switch event.Type {
	case ToolEventStarted:
		fmt.Fprintf(out, "tool_event type=%s call_id=%q tool=%q args=%s\n", event.Type, event.ToolCallID, event.ToolName, event.ArgsRaw)
	case ToolEventSucceeded:
		fmt.Fprintf(out, "tool_event type=%s call_id=%q tool=%q duration_ms=%d result_bytes=%d\n", event.Type, event.ToolCallID, event.ToolName, event.Duration.Milliseconds(), len(event.ResultRaw))
	case ToolEventFailed:
		fmt.Fprintf(out, "tool_event type=%s call_id=%q tool=%q duration_ms=%d error=%q\n", event.Type, event.ToolCallID, event.ToolName, event.Duration.Milliseconds(), event.Err)
	}
}

type StatusIndicator struct {
	out      io.Writer
	label    string
	delay    time.Duration
	interval time.Duration
	done     chan struct{}
	once     sync.Once
	wg       sync.WaitGroup
}

func NewStatusIndicator(out io.Writer, label string) *StatusIndicator {
	return NewStatusIndicatorWithDelay(out, label, statusDelay)
}

func NewStatusIndicatorWithDelay(out io.Writer, label string, delay time.Duration) *StatusIndicator {
	if out == nil {
		out = os.Stdout
	}
	return &StatusIndicator{
		out:      out,
		label:    label,
		delay:    delay,
		interval: statusFrameInterval,
		done:     make(chan struct{}),
	}
}

func (s *StatusIndicator) Start() {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		timer := time.NewTimer(s.delay)
		defer timer.Stop()
		select {
		case <-s.done:
			return
		case <-timer.C:
		}

		frames := []string{"|", "/", "-", "\\"}
		idx := 0
		render := func() {
			fmt.Fprintf(s.out, "\r\u001b[90m%s %s\u001b[0m", frames[idx%len(frames)], s.label)
			idx++
		}
		render()

		ticker := time.NewTicker(s.interval)
		defer ticker.Stop()
		for {
			select {
			case <-s.done:
				fmt.Fprint(s.out, "\r\u001b[2K\r")
				return
			case <-ticker.C:
				render()
			}
		}
	}()
}

func (s *StatusIndicator) Stop() {
	if s == nil {
		return
	}
	s.once.Do(func() {
		close(s.done)
	})
	s.wg.Wait()
}

type ChatMessage struct {
	Role             string         `json:"role"`
	Content          interface{}    `json:"content,omitempty"`
	Reasoning        string         `json:"reasoning,omitempty"`
	ReasoningContent string         `json:"reasoning_content,omitempty"`
	ToolCalls        []ChatToolCall `json:"tool_calls,omitempty"`
	ToolCallID       string         `json:"tool_call_id,omitempty"`
}

type ChatToolCall struct {
	ID       string               `json:"id"`
	Type     string               `json:"type"`
	Function ChatToolCallFunction `json:"function"`
}

type ChatToolCallFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type ChatTool struct {
	Type     string           `json:"type"`
	Function ChatToolFunction `json:"function"`
}

type ChatToolFunction struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description,omitempty"`
	Parameters  map[string]interface{} `json:"parameters"`
	Strict      bool                   `json:"strict,omitempty"`
}

type ChatCompletionRequest struct {
	Model      string        `json:"model"`
	Messages   []ChatMessage `json:"messages"`
	MaxTokens  int           `json:"max_tokens,omitempty"`
	Stream     bool          `json:"stream,omitempty"`
	Tools      []ChatTool    `json:"tools,omitempty"`
	ToolChoice string        `json:"tool_choice,omitempty"`
}

type ChatCompletionResponse struct {
	ID      string `json:"id"`
	Model   string `json:"model"`
	Choices []struct {
		Index   int         `json:"index"`
		Message ChatMessage `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type ChatCompletionStreamResponse struct {
	ID      string `json:"id"`
	Model   string `json:"model"`
	Choices []struct {
		Index int `json:"index"`
		Delta struct {
			Role             string              `json:"role,omitempty"`
			Content          interface{}         `json:"content,omitempty"`
			Reasoning        string              `json:"reasoning,omitempty"`
			ReasoningContent string              `json:"reasoning_content,omitempty"`
			ToolCalls        []ChatToolCallDelta `json:"tool_calls,omitempty"`
		} `json:"delta"`
		Message      ChatMessage `json:"message,omitempty"`
		FinishReason string      `json:"finish_reason,omitempty"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type ChatToolCallDelta struct {
	Index    int    `json:"index"`
	ID       string `json:"id,omitempty"`
	Type     string `json:"type,omitempty"`
	Function struct {
		Name      string `json:"name,omitempty"`
		Arguments string `json:"arguments,omitempty"`
	} `json:"function,omitempty"`
}

func main() {
	cfg, err := LoadConfig()
	if err != nil {
		fmt.Printf("Error: %s\n", err.Error())
		os.Exit(1)
	}

	if cfg.Discord.BotToken != "" {
		if err := runDiscordBot(context.Background(), cfg); err != nil {
			fmt.Printf("Error: %s\n", err.Error())
		}
		return
	}

	baseURL := strings.TrimRight(cfg.Provider.BaseURL, "/")
	apiKey := cfg.Provider.APIKey
	if apiKey == "" && baseURL == defaultVultrBaseURL {
		fmt.Println("Error: API key is required (set via the env var named in api_key_env)")
		os.Exit(1)
	}

	scanner := bufio.NewScanner(os.Stdin)
	getUserMessage := func() (string, bool) {
		if !scanner.Scan() {
			return "", false
		}
		return scanner.Text(), true
	}

	agent := NewAgent(baseURL, apiKey, http.DefaultClient, getUserMessage, nil, cfg)
	configureToolEventLogging(agent)
	configureServerEventLogging(agent, os.Stdout)
	configureMemory(context.Background(), agent, cfg)
	configureWebSearch(agent, cfg)
	if err := agent.Run(context.Background()); err != nil {
		fmt.Printf("Error: %s\n", err.Error())
	}
	agent.WaitForAsync()
}

func NewAgent(
	baseURL, apiKey string,
	httpClient *http.Client,
	getUserMessage func() (string, bool),
	tools []ToolDefinition,
	cfg *ResolvedConfig,
) *Agent {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}

	primaryModel := Instruct
	reasoningModel := Reasoning
	summarizationModel := Summarization
	if cfg != nil {
		if cfg.Provider.PrimaryModel != "" {
			primaryModel = Model(cfg.Provider.PrimaryModel)
		}
		if cfg.Provider.ReasoningModel != "" {
			reasoningModel = Model(cfg.Provider.ReasoningModel)
		}
		if cfg.Provider.SummarizationModel != "" {
			summarizationModel = Model(cfg.Provider.SummarizationModel)
		}
	}

	agent := &Agent{
		baseURL:            baseURL,
		apiKey:             apiKey,
		primaryModel:       primaryModel,
		reasoningModel:     reasoningModel,
		summarizationModel: summarizationModel,
		promptBuilder:      NewSectionedPromptBuilder(promptConfigFromCfg(cfg)),
		promptTransport:    "cli",
		httpClient:         httpClient,
		getUserMessage:     getUserMessage,
		outputWriter:       os.Stdout,
	}
	if cfg != nil && len(cfg.Provider.ThinkingToggleKeypath) > 0 {
		agent.thinkingToggleKeypath = cfg.Provider.ThinkingToggleKeypath
		agent.thinkingToggleOnValue = cfg.Provider.ThinkingToggleOnValue
		agent.thinkingToggleOffValue = cfg.Provider.ThinkingToggleOffValue
		if agent.thinkingToggleOnValue == nil {
			agent.thinkingToggleOnValue = true
		}
		if agent.thinkingToggleOffValue == nil {
			agent.thinkingToggleOffValue = false
		}
	}
	var workDir string
	if cfg != nil {
		workDir = cfg.Config.Agent.WorkingDirectory
	}
	sb, err := NewSandbox(workDir)
	if err != nil {
		panic(fmt.Sprintf("fatal: sandbox initialization failed: %v", err))
	}
	agent.sandbox = sb
	agent.tools = agent.buildTools(tools)
	return agent
}

func configureToolEventLogging(agent *Agent) {
	mode, ok := parseToolEventLogMode(os.Getenv("TOOL_EVENT_LOG"))
	if !ok {
		fmt.Fprintf(os.Stderr, "Warning: invalid TOOL_EVENT_LOG=%q; defaulting to %q\n", os.Getenv("TOOL_EVENT_LOG"), ToolEventLogOff)
		mode = ToolEventLogOff
	}
	switch mode {
	case ToolEventLogDebug:
		agent.toolEventSink = &CLIToolEventSink{out: os.Stderr}
	default:
		agent.toolEventSink = nil
	}
}

func configureServerEventLogging(agent *Agent, out io.Writer) {
	agent.serverEventSink = newServerEventSinkFromEnv(out)
}

func newServerEventSinkFromEnv(out io.Writer) ServerEventSink {
	mode, ok := parseServerEventLogMode(os.Getenv("SERVER_EVENT_LOG"))
	if !ok {
		fmt.Fprintf(os.Stderr, "Warning: invalid SERVER_EVENT_LOG=%q; defaulting to %q\n", os.Getenv("SERVER_EVENT_LOG"), ServerEventLogOff)
		mode = ServerEventLogOff
	}
	switch mode {
	case ServerEventLogLine:
		return &LineServerEventSink{out: out}
	case ServerEventLogVerbose:
		return &LineServerEventSink{out: out, verboseContent: true}
	default:
		return nil
	}
}

func parseToolEventLogMode(raw string) (ToolEventLogMode, bool) {
	value := strings.TrimSpace(strings.ToLower(raw))
	if value == "" {
		return ToolEventLogOff, true
	}
	switch ToolEventLogMode(value) {
	case ToolEventLogOff, ToolEventLogDebug:
		return ToolEventLogMode(value), true
	default:
		return ToolEventLogOff, false
	}
}

func parseServerEventLogMode(raw string) (ServerEventLogMode, bool) {
	value := strings.TrimSpace(strings.ToLower(raw))
	if value == "" {
		return ServerEventLogOff, true
	}
	switch ServerEventLogMode(value) {
	case ServerEventLogOff, ServerEventLogLine, ServerEventLogVerbose:
		return ServerEventLogMode(value), true
	default:
		return ServerEventLogOff, false
	}
}

func serverEventSinkIncludesVerboseContent(sink ServerEventSink) bool {
	lineSink, ok := sink.(*LineServerEventSink)
	return ok && lineSink.verboseContent
}

func (a *Agent) buildTools(extraTools []ToolDefinition) []ToolDefinition {
	tools := []ToolDefinition{
		a.readFileToolDefinition(),
		a.listFilesToolDefinition(),
		a.editFileToolDefinition(),
	}
	tools = append(tools, a.reasoningToolDefinition())
	if a.memoryClient != nil {
		tools = append(tools, a.recordToolDefinition())
		tools = append(tools, a.recallToolDefinition())
	}
	if a.webSearchClient != nil {
		tools = append(tools, a.webSearchToolDefinition())
	}
	for _, extra := range extraTools {
		replaced := false
		for i := range tools {
			if tools[i].Name == extra.Name {
				tools[i] = extra
				replaced = true
				break
			}
		}
		if !replaced {
			tools = append(tools, extra)
		}
	}
	return tools
}

func (a *Agent) readFileToolDefinition() ToolDefinition {
	return ToolDefinition{
		Name:        "read_file",
		Description: "Read the contents of a file. Paths are relative to the working directory. Use this when you want to see what's inside a file. Do not use this with directory names.",
		InputSchema: ReadFileInputSchema,
		Function: func(input json.RawMessage) (string, error) {
			var args ReadFileInput
			if err := json.Unmarshal(input, &args); err != nil {
				return "", err
			}
			resolved, err := a.sandbox.Resolve(args.Path)
			if err != nil {
				return "", err
			}
			content, err := os.ReadFile(resolved)
			if err != nil {
				return "", err
			}
			return string(content), nil
		},
	}
}

func (a *Agent) listFilesToolDefinition() ToolDefinition {
	return ToolDefinition{
		Name:        "list_files",
		Description: "List files and directories at a given path (non-recursive). If no path is provided, lists files in the working directory.",
		InputSchema: ListFilesInputSchema,
		Function: func(input json.RawMessage) (string, error) {
			var args ListFilesInput
			if err := json.Unmarshal(input, &args); err != nil {
				return "", err
			}
			resolved, err := a.sandbox.Resolve(args.Path)
			if err != nil {
				return "", err
			}
			entries, err := os.ReadDir(resolved)
			if err != nil {
				return "", err
			}
			var files []string
			for _, entry := range entries {
				name := entry.Name()
				if entry.IsDir() {
					files = append(files, name+"/")
				} else {
					files = append(files, name)
				}
			}
			result, err := json.Marshal(files)
			if err != nil {
				return "", err
			}
			return string(result), nil
		},
	}
}

func (a *Agent) editFileToolDefinition() ToolDefinition {
	return ToolDefinition{
		Name: "edit_file",
		Description: `Make edits to a text file. Paths are relative to the working directory.

Replaces 'old_str' with 'new_str' in the given file. 'old_str' and 'new_str' MUST be different from each other.

If the file specified with path doesn't exist, it will be created.`,
		InputSchema: EditFileInputSchema,
		Function: func(input json.RawMessage) (string, error) {
			var args EditFileInput
			if err := json.Unmarshal(input, &args); err != nil {
				return "", err
			}
			if args.Path == "" || args.OldStr == args.NewStr {
				return "", fmt.Errorf("invalid input parameters")
			}
			resolved, err := a.sandbox.Resolve(args.Path)
			if err != nil {
				return "", err
			}
			content, err := os.ReadFile(resolved)
			if err != nil {
				if os.IsNotExist(err) && args.OldStr == "" {
					return createNewFile(resolved, args.NewStr)
				}
				return "", err
			}
			oldContent := string(content)
			newContent := strings.Replace(oldContent, args.OldStr, args.NewStr, -1)
			if oldContent == newContent && args.OldStr != "" {
				return "", fmt.Errorf("old_str not found in file")
			}
			if err := os.WriteFile(resolved, []byte(newContent), 0o644); err != nil {
				return "", err
			}
			return "OK", nil
		},
	}
}

func (a *Agent) reasoningToolDefinition() ToolDefinition {
	return ToolDefinition{
		Name:        "delegate_reasoning",
		Description: "Use only for hard reasoning/planning tasks that require multi-step analysis, tradeoff evaluation, or synthesis (e.g., strategy, architecture, proofs, constraint-solving). Do not use for simple arithmetic, factual lookups, definitions, day/date lookups, rewriting, or straightforward formatting/minification. Provide the question plus concise context. Returns a distilled reasoning result from gpt-oss-120b.",
		InputSchema: DelegateReasoningInputSchema,
		Function:    a.delegateReasoning,
	}
}

func (a *Agent) Run(ctx context.Context) error {
	cs := NewConversationState()

	fmt.Println("Chat with Vultr Inference (use 'ctrl-c' to quit)")

	readUserInput := true
	for {
		if readUserInput {
			a.reasoningCallCount = 0
			if a.recallTurnCache != nil {
				a.recallTurnCache.invalidate()
			}
			fmt.Print("\u001b[94mYou\u001b[0m: ")
			userInput, ok := a.getUserMessage()
			if !ok {
				break
			}
			cs.Append(ChatMessage{
				Role:    "user",
				Content: userInput,
			})
		}

		spinner := NewStatusIndicator(a.cliOutputWriter(), "waiting for model...")
		spinner.Start()

		inferCtx := withConversationSummary(ctx, cs.Summary)
		streamedAnyText := false
		assistantHeaderPrinted := false
		message, err := a.runInferenceStream(inferCtx, cs.Messages, func(delta string) {
			if delta == "" {
				return
			}
			spinner.Stop()
			if !assistantHeaderPrinted {
				fmt.Print("\u001b[93mAssistant\u001b[0m: ")
				assistantHeaderPrinted = true
			}
			streamedAnyText = true
			fmt.Print(delta)
		})
		spinner.Stop()
		if err != nil {
			if streamedAnyText {
				fmt.Print("\n[stream interrupted]\n")
			}
			return err
		}
		cs.Append(message)

		if streamedAnyText {
			fmt.Println()
		} else if text, ok := message.Content.(string); ok && text != "" {
			fmt.Printf("\u001b[93mAssistant\u001b[0m: %s\n", text)
		}

		if len(message.ToolCalls) == 0 {
			readUserInput = true
			a.compactConversation(ctx, cs)
			continue
		}

		for _, toolCall := range message.ToolCalls {
			if tool := a.findTool(toolCall.Function.Name); tool != nil && tool.Async {
				a.asyncWg.Add(1)
				go func(tc ChatToolCall) {
					defer a.asyncWg.Done()
					a.executeTool(ctx, tc)
				}(toolCall)
				cs.Append(ChatMessage{
					Role:       "tool",
					ToolCallID: toolCall.ID,
					Content:    "Accepted.",
				})
			} else {
				toolResult := a.executeTool(ctx, toolCall)
				cs.Append(toolResult)
			}
		}
		readUserInput = false
	}

	return nil
}

func (a *Agent) runInference(ctx context.Context, conversation []ChatMessage) (ChatMessage, error) {
	return a.runInferenceWithModel(ctx, a.primaryModel, conversation, a.tools, primaryMaxTokens, PromptModeFull, false)
}

func (a *Agent) runInferenceStream(
	ctx context.Context,
	conversation []ChatMessage,
	onTextDelta func(string),
) (ChatMessage, error) {
	return a.runInferenceStreamWithModel(ctx, a.primaryModel, conversation, a.tools, primaryMaxTokens, onTextDelta, PromptModeFull, false)
}

func (a *Agent) withSystemPrompt(ctx context.Context, conversation []ChatMessage, tools []ToolDefinition, mode PromptMode) []ChatMessage {
	if a.promptBuilder == nil {
		return conversation
	}
	toolNames := make([]string, 0, len(tools))
	for _, tool := range tools {
		toolNames = append(toolNames, tool.Name)
	}
	buildCtx := PromptBuildContext{
		Mode:      mode,
		Transport: a.promptTransport,
		ToolNames: toolNames,
	}
	if a.sandbox != nil {
		buildCtx.WorkingDirectory = a.sandbox.Root()
	}
	prompt := a.promptBuilder.Build(buildCtx)

	// Inject [Memory] section for full mode only. Minimal mode (used by
	// delegated reasoning) operates on a standalone sub-prompt and does not
	// benefit from memory context.
	if mode == PromptModeFull {
		query := ""
		for i := len(conversation) - 1; i >= 0; i-- {
			if conversation[i].Role == "user" {
				if text, ok := conversation[i].Content.(string); ok {
					query = strings.TrimSpace(text)
				}
				break
			}
		}
		if recalled := a.recallMemories(ctx, query); recalled != "" {
			prompt = prompt + "\n\n" + recalled
		}
	}

	if summary := conversationSummaryFromContext(ctx); summary != "" {
		prompt += "\n\n" + formatSection("Conversation Summary", summary)
	}

	return prependSystemPrompt(conversation, prompt)
}

// injectThinkingToggle merges the thinking toggle into the marshaled request
// body when thinkingToggleKeypath is configured. The thinking parameter selects
// whether the on or off value is injected.
func (a *Agent) injectThinkingToggle(body []byte, thinking bool) ([]byte, error) {
	if len(a.thinkingToggleKeypath) == 0 {
		return body, nil
	}

	value := a.thinkingToggleOffValue
	if thinking {
		value = a.thinkingToggleOnValue
	}

	// Build the nested structure from keypath, bottom-up.
	var nested interface{} = value
	for i := len(a.thinkingToggleKeypath) - 1; i >= 0; i-- {
		nested = map[string]interface{}{a.thinkingToggleKeypath[i]: nested}
	}

	// Merge into the request body.
	var requestMap map[string]interface{}
	if err := json.Unmarshal(body, &requestMap); err != nil {
		return nil, err
	}
	if topLevel, ok := nested.(map[string]interface{}); ok {
		for k, v := range topLevel {
			requestMap[k] = v
		}
	}
	return json.Marshal(requestMap)
}

func (a *Agent) runInferenceWithModel(
	ctx context.Context,
	model Model,
	conversation []ChatMessage,
	tools []ToolDefinition,
	maxTokens int,
	mode PromptMode,
	thinking bool,
) (ChatMessage, error) {
	promptedConversation := a.withSystemPrompt(ctx, conversation, tools, mode)
	startedAt := time.Now()
	a.emitServerEvent(ctx, ServerLogLevelInfo, "llm.request.started", "inference request started", map[string]interface{}{
		"model":    string(model),
		"stream":   false,
		"messages": len(promptedConversation),
		"tools":    len(tools),
	})

	chatTools := []ChatTool{}
	for _, tool := range tools {
		chatTools = append(chatTools, ChatTool{
			Type: "function",
			Function: ChatToolFunction{
				Name:        tool.Name,
				Description: tool.Description,
				Parameters:  tool.InputSchema,
			},
		})
	}

	requestBody := ChatCompletionRequest{
		Model:     string(model),
		MaxTokens: maxTokens,
		Messages:  promptedConversation,
		Tools:     chatTools,
	}
	if len(chatTools) > 0 {
		requestBody.ToolChoice = "auto"
	}

	body, err := json.Marshal(requestBody)
	if err != nil {
		a.emitServerEvent(ctx, ServerLogLevelError, "llm.request.failed", "inference request failed", map[string]interface{}{
			"model":       string(model),
			"stream":      false,
			"duration_ms": time.Since(startedAt).Milliseconds(),
			"error":       err.Error(),
		})
		return ChatMessage{}, err
	}
	body, err = a.injectThinkingToggle(body, thinking)
	if err != nil {
		a.emitServerEvent(ctx, ServerLogLevelError, "llm.request.failed", "inference request failed", map[string]interface{}{
			"model":       string(model),
			"stream":      false,
			"duration_ms": time.Since(startedAt).Milliseconds(),
			"error":       err.Error(),
		})
		return ChatMessage{}, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		a.emitServerEvent(ctx, ServerLogLevelError, "llm.request.failed", "inference request failed", map[string]interface{}{
			"model":       string(model),
			"stream":      false,
			"duration_ms": time.Since(startedAt).Milliseconds(),
			"error":       err.Error(),
		})
		return ChatMessage{}, err
	}
	if a.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+a.apiKey)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := a.httpClient.Do(req)
	if err != nil {
		a.emitServerEvent(ctx, ServerLogLevelError, "llm.request.failed", "inference request failed", map[string]interface{}{
			"model":       string(model),
			"stream":      false,
			"duration_ms": time.Since(startedAt).Milliseconds(),
			"error":       err.Error(),
		})
		return ChatMessage{}, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		a.emitServerEvent(ctx, ServerLogLevelError, "llm.request.failed", "inference request failed", map[string]interface{}{
			"model":       string(model),
			"stream":      false,
			"duration_ms": time.Since(startedAt).Milliseconds(),
			"error":       err.Error(),
		})
		return ChatMessage{}, err
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		requestErr := fmt.Errorf("vultr api error (%d): %s", resp.StatusCode, string(respBody))
		a.emitServerEvent(ctx, ServerLogLevelError, "llm.request.failed", "inference request failed", map[string]interface{}{
			"model":       string(model),
			"stream":      false,
			"duration_ms": time.Since(startedAt).Milliseconds(),
			"status_code": resp.StatusCode,
			"error":       requestErr.Error(),
		})
		return ChatMessage{}, requestErr
	}

	var completion ChatCompletionResponse
	if err := json.Unmarshal(respBody, &completion); err != nil {
		a.emitServerEvent(ctx, ServerLogLevelError, "llm.request.failed", "inference request failed", map[string]interface{}{
			"model":       string(model),
			"stream":      false,
			"duration_ms": time.Since(startedAt).Milliseconds(),
			"error":       err.Error(),
		})
		return ChatMessage{}, err
	}

	if completion.Error != nil && completion.Error.Message != "" {
		requestErr := fmt.Errorf("vultr api error: %s", completion.Error.Message)
		a.emitServerEvent(ctx, ServerLogLevelError, "llm.request.failed", "inference request failed", map[string]interface{}{
			"model":       string(model),
			"stream":      false,
			"duration_ms": time.Since(startedAt).Milliseconds(),
			"error":       requestErr.Error(),
		})
		return ChatMessage{}, requestErr
	}

	if len(completion.Choices) == 0 {
		requestErr := fmt.Errorf("vultr api returned no choices")
		a.emitServerEvent(ctx, ServerLogLevelError, "llm.request.failed", "inference request failed", map[string]interface{}{
			"model":       string(model),
			"stream":      false,
			"duration_ms": time.Since(startedAt).Milliseconds(),
			"error":       requestErr.Error(),
		})
		return ChatMessage{}, requestErr
	}

	message := completion.Choices[0].Message
	a.emitServerEvent(ctx, ServerLogLevelInfo, "llm.request.completed", "inference completed", map[string]interface{}{
		"model":        string(model),
		"stream":       false,
		"duration_ms":  time.Since(startedAt).Milliseconds(),
		"output_chars": len(streamContentToString(message.Content)),
		"tool_calls":   len(message.ToolCalls),
	})
	return message, nil
}

func (a *Agent) runInferenceStreamWithModel(
	ctx context.Context,
	model Model,
	conversation []ChatMessage,
	tools []ToolDefinition,
	maxTokens int,
	onTextDelta func(string),
	mode PromptMode,
	thinking bool,
) (ChatMessage, error) {
	promptedConversation := a.withSystemPrompt(ctx, conversation, tools, mode)
	startedAt := time.Now()
	a.emitServerEvent(ctx, ServerLogLevelInfo, "llm.request.started", "inference request started", map[string]interface{}{
		"model":    string(model),
		"stream":   true,
		"messages": len(promptedConversation),
		"tools":    len(tools),
	})

	chatTools := []ChatTool{}
	for _, tool := range tools {
		chatTools = append(chatTools, ChatTool{
			Type: "function",
			Function: ChatToolFunction{
				Name:        tool.Name,
				Description: tool.Description,
				Parameters:  tool.InputSchema,
			},
		})
	}

	requestBody := ChatCompletionRequest{
		Model:     string(model),
		MaxTokens: maxTokens,
		Messages:  promptedConversation,
		Stream:    true,
		Tools:     chatTools,
	}
	if len(chatTools) > 0 {
		requestBody.ToolChoice = "auto"
	}

	body, err := json.Marshal(requestBody)
	if err != nil {
		a.emitServerEvent(ctx, ServerLogLevelError, "llm.request.failed", "inference request failed", map[string]interface{}{
			"model":       string(model),
			"stream":      true,
			"duration_ms": time.Since(startedAt).Milliseconds(),
			"error":       err.Error(),
		})
		return ChatMessage{}, err
	}
	body, err = a.injectThinkingToggle(body, thinking)
	if err != nil {
		a.emitServerEvent(ctx, ServerLogLevelError, "llm.request.failed", "inference request failed", map[string]interface{}{
			"model":       string(model),
			"stream":      true,
			"duration_ms": time.Since(startedAt).Milliseconds(),
			"error":       err.Error(),
		})
		return ChatMessage{}, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		a.emitServerEvent(ctx, ServerLogLevelError, "llm.request.failed", "inference request failed", map[string]interface{}{
			"model":       string(model),
			"stream":      true,
			"duration_ms": time.Since(startedAt).Milliseconds(),
			"error":       err.Error(),
		})
		return ChatMessage{}, err
	}
	if a.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+a.apiKey)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := a.httpClient.Do(req)
	if err != nil {
		a.emitServerEvent(ctx, ServerLogLevelError, "llm.request.failed", "inference request failed", map[string]interface{}{
			"model":       string(model),
			"stream":      true,
			"duration_ms": time.Since(startedAt).Milliseconds(),
			"error":       err.Error(),
		})
		return ChatMessage{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, readErr := io.ReadAll(resp.Body)
		if readErr != nil {
			requestErr := fmt.Errorf("vultr api error (%d): failed to read body: %w", resp.StatusCode, readErr)
			a.emitServerEvent(ctx, ServerLogLevelError, "llm.request.failed", "inference request failed", map[string]interface{}{
				"model":       string(model),
				"stream":      true,
				"duration_ms": time.Since(startedAt).Milliseconds(),
				"status_code": resp.StatusCode,
				"error":       requestErr.Error(),
			})
			return ChatMessage{}, requestErr
		}
		requestErr := fmt.Errorf("vultr api error (%d): %s", resp.StatusCode, string(respBody))
		a.emitServerEvent(ctx, ServerLogLevelError, "llm.request.failed", "inference request failed", map[string]interface{}{
			"model":       string(model),
			"stream":      true,
			"duration_ms": time.Since(startedAt).Milliseconds(),
			"status_code": resp.StatusCode,
			"error":       requestErr.Error(),
		})
		return ChatMessage{}, requestErr
	}

	reader := bufio.NewReader(resp.Body)
	message := ChatMessage{Role: "assistant"}
	var contentBuilder strings.Builder
	var reasoningBuilder strings.Builder
	toolCallsByIndex := map[int]*ChatToolCall{}
	toolCallOrder := []int{}
	var eventLines []string
	sawFirstText := false
	wrappedTextDelta := func(delta string) {
		if delta != "" && !sawFirstText {
			sawFirstText = true
			a.emitServerEvent(ctx, ServerLogLevelInfo, "llm.stream.first_token", "first token received", map[string]interface{}{
				"model":   string(model),
				"ttfb_ms": time.Since(startedAt).Milliseconds(),
			})
		}
		if onTextDelta != nil {
			onTextDelta(delta)
		}
	}

	for {
		line, readErr := reader.ReadString('\n')
		line = strings.TrimRight(line, "\r\n")
		if strings.HasPrefix(line, "data:") {
			eventLines = append(eventLines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}

		if line == "" && len(eventLines) > 0 {
			if err := a.processStreamEvent(strings.Join(eventLines, "\n"), &message, &contentBuilder, &reasoningBuilder, toolCallsByIndex, &toolCallOrder, wrappedTextDelta); err != nil {
				a.emitServerEvent(ctx, ServerLogLevelError, "llm.request.failed", "inference request failed", map[string]interface{}{
					"model":       string(model),
					"stream":      true,
					"duration_ms": time.Since(startedAt).Milliseconds(),
					"error":       err.Error(),
				})
				return ChatMessage{}, err
			}
			eventLines = eventLines[:0]
		}

		if readErr != nil {
			if readErr == io.EOF {
				if len(eventLines) > 0 {
					if err := a.processStreamEvent(strings.Join(eventLines, "\n"), &message, &contentBuilder, &reasoningBuilder, toolCallsByIndex, &toolCallOrder, wrappedTextDelta); err != nil {
						a.emitServerEvent(ctx, ServerLogLevelError, "llm.request.failed", "inference request failed", map[string]interface{}{
							"model":       string(model),
							"stream":      true,
							"duration_ms": time.Since(startedAt).Milliseconds(),
							"error":       err.Error(),
						})
						return ChatMessage{}, err
					}
				}
				break
			}
			a.emitServerEvent(ctx, ServerLogLevelError, "llm.request.failed", "inference request failed", map[string]interface{}{
				"model":       string(model),
				"stream":      true,
				"duration_ms": time.Since(startedAt).Milliseconds(),
				"error":       readErr.Error(),
			})
			return ChatMessage{}, readErr
		}
	}

	if contentBuilder.Len() > 0 {
		message.Content = contentBuilder.String()
	}
	if reasoningBuilder.Len() > 0 {
		message.Reasoning = reasoningBuilder.String()
	}
	for _, idx := range toolCallOrder {
		if call := toolCallsByIndex[idx]; call != nil {
			message.ToolCalls = append(message.ToolCalls, *call)
		}
	}
	a.emitServerEvent(ctx, ServerLogLevelInfo, "llm.request.completed", "inference completed", map[string]interface{}{
		"model":        string(model),
		"stream":       true,
		"duration_ms":  time.Since(startedAt).Milliseconds(),
		"output_chars": len(streamContentToString(message.Content)),
		"tool_calls":   len(message.ToolCalls),
	})

	return message, nil
}

func (a *Agent) processStreamEvent(
	payload string,
	message *ChatMessage,
	contentBuilder *strings.Builder,
	reasoningBuilder *strings.Builder,
	toolCallsByIndex map[int]*ChatToolCall,
	toolCallOrder *[]int,
	onTextDelta func(string),
) error {
	if strings.TrimSpace(payload) == "" || payload == "[DONE]" {
		return nil
	}

	var chunk ChatCompletionStreamResponse
	if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
		return err
	}
	if chunk.Error != nil && chunk.Error.Message != "" {
		return fmt.Errorf("vultr api error: %s", chunk.Error.Message)
	}

	for _, choice := range chunk.Choices {
		if choice.Message.Role != "" {
			*message = choice.Message
			continue
		}
		if choice.Delta.Role != "" {
			message.Role = choice.Delta.Role
		}

		text := streamContentToString(choice.Delta.Content)
		if text != "" {
			contentBuilder.WriteString(text)
			if onTextDelta != nil {
				onTextDelta(text)
			}
		}
		if choice.Delta.Reasoning != "" {
			reasoningBuilder.WriteString(choice.Delta.Reasoning)
		}
		if choice.Delta.ReasoningContent != "" {
			reasoningBuilder.WriteString(choice.Delta.ReasoningContent)
		}
		for _, deltaCall := range choice.Delta.ToolCalls {
			call, exists := toolCallsByIndex[deltaCall.Index]
			if !exists {
				call = &ChatToolCall{Type: "function"}
				toolCallsByIndex[deltaCall.Index] = call
				*toolCallOrder = append(*toolCallOrder, deltaCall.Index)
			}
			if deltaCall.ID != "" {
				call.ID = deltaCall.ID
			}
			if deltaCall.Type != "" {
				call.Type = deltaCall.Type
			}
			if deltaCall.Function.Name != "" {
				call.Function.Name += deltaCall.Function.Name
			}
			if deltaCall.Function.Arguments != "" {
				call.Function.Arguments += deltaCall.Function.Arguments
			}
		}
	}

	return nil
}

func streamContentToString(v interface{}) string {
	switch content := v.(type) {
	case string:
		return content
	case []interface{}:
		var b strings.Builder
		for _, part := range content {
			obj, ok := part.(map[string]interface{})
			if !ok {
				continue
			}
			text, _ := obj["text"].(string)
			b.WriteString(text)
		}
		return b.String()
	default:
		return ""
	}
}

func (a *Agent) WaitForAsync() {
	a.asyncWg.Wait()
}

func (a *Agent) findTool(name string) *ToolDefinition {
	for i := range a.tools {
		if a.tools[i].Name == name {
			return &a.tools[i]
		}
	}
	return nil
}

func (a *Agent) executeTool(ctx context.Context, toolCall ChatToolCall) ChatMessage {
	startedAt := time.Now()
	rawArgs := "{}"
	if toolCall.Function.Arguments != "" {
		rawArgs = toolCall.Function.Arguments
	}
	parsedArgs := parseToolArgs(rawArgs)
	stats := precomputeToolStats(toolCall.Function.Name, parsedArgs)
	a.emitToolEvent(ctx, ToolEvent{
		Type:       ToolEventStarted,
		ToolCallID: toolCall.ID,
		ToolName:   toolCall.Function.Name,
		ArgsRaw:    rawArgs,
		ArgsParsed: parsedArgs,
		Stats:      stats,
		StartedAt:  startedAt,
	})

	var toolDef ToolDefinition
	found := false
	for _, tool := range a.tools {
		if tool.Name == toolCall.Function.Name {
			toolDef = tool
			found = true
			break
		}
	}

	if !found {
		a.emitToolEvent(ctx, ToolEvent{
			Type:       ToolEventFailed,
			ToolCallID: toolCall.ID,
			ToolName:   toolCall.Function.Name,
			ArgsRaw:    rawArgs,
			ArgsParsed: parsedArgs,
			Stats:      stats,
			Err:        "tool not found",
			StartedAt:  startedAt,
			Duration:   time.Since(startedAt),
		})
		return ChatMessage{
			Role:       "tool",
			ToolCallID: toolCall.ID,
			Content:    "tool not found",
		}
	}

	rawInput := json.RawMessage("{}")
	if toolCall.Function.Arguments != "" {
		rawInput = json.RawMessage(toolCall.Function.Arguments)
	}

	var spinner *StatusIndicator
	if toolCall.Function.Name != "delegate_reasoning" {
		spinner = NewStatusIndicatorWithDelay(a.cliOutputWriter(), fmt.Sprintf("running %s...", toolCall.Function.Name), toolStatusDelay)
		spinner.Start()
	}

	response, err := toolDef.Function(rawInput)
	if spinner != nil {
		spinner.Stop()
	}
	if err != nil {
		a.emitToolEvent(ctx, ToolEvent{
			Type:       ToolEventFailed,
			ToolCallID: toolCall.ID,
			ToolName:   toolCall.Function.Name,
			ArgsRaw:    rawArgs,
			ArgsParsed: parsedArgs,
			Stats:      stats,
			Err:        err.Error(),
			StartedAt:  startedAt,
			Duration:   time.Since(startedAt),
		})
		return ChatMessage{
			Role:       "tool",
			ToolCallID: toolCall.ID,
			Content:    err.Error(),
		}
	}
	a.emitToolEvent(ctx, ToolEvent{
		Type:       ToolEventSucceeded,
		ToolCallID: toolCall.ID,
		ToolName:   toolCall.Function.Name,
		ArgsRaw:    rawArgs,
		ArgsParsed: parsedArgs,
		Stats:      stats,
		ResultRaw:  response,
		StartedAt:  startedAt,
		Duration:   time.Since(startedAt),
	})
	return ChatMessage{
		Role:       "tool",
		ToolCallID: toolCall.ID,
		Content:    response,
	}
}

func (a *Agent) emitToolEvent(ctx context.Context, event ToolEvent) {
	if a.toolEventSink == nil {
		a.emitServerEventFromToolEvent(ctx, event)
		return
	}
	a.toolEventSink.HandleToolEvent(ctx, event)
	a.emitServerEventFromToolEvent(ctx, event)
}

func (a *Agent) emitServerEventFromToolEvent(ctx context.Context, event ToolEvent) {
	fields := map[string]interface{}{
		"tool":    event.ToolName,
		"call_id": event.ToolCallID,
	}
	switch event.Type {
	case ToolEventStarted:
		fields["args_present"] = strings.TrimSpace(event.ArgsRaw) != "{}"
		a.emitServerEvent(ctx, ServerLogLevelInfo, string(ToolEventStarted), "tool execution started", fields)
	case ToolEventSucceeded:
		fields["duration_ms"] = event.Duration.Milliseconds()
		fields["result_bytes"] = len(event.ResultRaw)
		for k, v := range event.Stats {
			fields[k] = v
		}
		a.emitServerEvent(ctx, ServerLogLevelInfo, string(ToolEventSucceeded), "tool execution succeeded", fields)
	case ToolEventFailed:
		fields["duration_ms"] = event.Duration.Milliseconds()
		fields["error"] = event.Err
		a.emitServerEvent(ctx, ServerLogLevelError, string(ToolEventFailed), "tool execution failed", fields)
	}
}

func (a *Agent) emitServerEvent(
	ctx context.Context,
	level ServerLogLevel,
	eventName, message string,
	fields map[string]interface{},
) {
	emitServerEventWithSink(ctx, a.serverEventSink, level, eventName, message, fields)
}

func emitServerEventWithSink(
	ctx context.Context,
	sink ServerEventSink,
	level ServerLogLevel,
	eventName, message string,
	fields map[string]interface{},
) {
	if sink == nil {
		return
	}
	meta := serverLogMetaFromContext(ctx)
	sink.HandleServerEvent(ctx, ServerEvent{
		TS:            time.Now().UTC(),
		Level:         level,
		Event:         eventName,
		Message:       message,
		TraceID:       meta.TraceID,
		TurnID:        meta.TurnID,
		SessionKey:    meta.SessionKey,
		Source:        meta.Source,
		ChannelID:     meta.ChannelID,
		UserIDHash:    meta.UserIDHash,
		MessageID:     meta.MessageID,
		InteractionID: meta.InteractionID,
		Fields:        fields,
	})
}

func (a *Agent) cliOutputWriter() io.Writer {
	if a.outputWriter != nil {
		return a.outputWriter
	}
	if sink, ok := a.toolEventSink.(*CLIToolEventSink); ok {
		if sink.out != nil {
			return sink.out
		}
	}
	return os.Stdout
}

func (a *Agent) setOutputWriter(w io.Writer) {
	a.outputWriter = w
}

func (a *Agent) setPromptTransport(transport string) {
	a.promptTransport = strings.TrimSpace(transport)
}

func (a *Agent) HandleUserMessage(ctx context.Context, cs *ConversationState, userInput string) (*ConversationState, string, error) {
	return a.HandleUserMessageProgressive(ctx, cs, userInput, nil)
}

func (a *Agent) HandleUserMessageProgressive(
	ctx context.Context,
	cs *ConversationState,
	userInput string,
	onResponsePart func(part string) error,
) (*ConversationState, string, error) {
	if cs == nil {
		cs = NewConversationState()
	}
	turnStartedAt := time.Now()
	a.emitServerEvent(ctx, ServerLogLevelInfo, "agent.turn.started", "turn started", map[string]interface{}{
		"conversation_len_before": len(cs.Messages),
	})

	a.reasoningCallCount = 0
	if a.recallTurnCache != nil {
		a.recallTurnCache.invalidate()
	}
	cs.Append(ChatMessage{
		Role:    "user",
		Content: userInput,
	})

	var responseParts []string
	toolCallsTotal := 0
	for {
		inferCtx := withConversationSummary(ctx, cs.Summary)
		message, err := a.runInference(inferCtx, cs.Messages)
		if err != nil {
			a.emitServerEvent(ctx, ServerLogLevelError, "agent.turn.failed", "turn failed", map[string]interface{}{
				"duration_ms": time.Since(turnStartedAt).Milliseconds(),
				"error":       err.Error(),
			})
			return nil, "", err
		}
		cs.Append(message)

		if text, ok := message.Content.(string); ok && strings.TrimSpace(text) != "" {
			responseParts = append(responseParts, text)
			if onResponsePart != nil {
				if err := onResponsePart(text); err != nil {
					a.emitServerEvent(ctx, ServerLogLevelError, "agent.turn.failed", "turn failed", map[string]interface{}{
						"duration_ms": time.Since(turnStartedAt).Milliseconds(),
						"error":       err.Error(),
					})
					return nil, "", err
				}
			}
		}

		if len(message.ToolCalls) == 0 {
			break
		}

		for _, toolCall := range message.ToolCalls {
			toolCallsTotal++
			if tool := a.findTool(toolCall.Function.Name); tool != nil && tool.Async {
				a.asyncWg.Add(1)
				go func(tc ChatToolCall) {
					defer a.asyncWg.Done()
					a.executeTool(ctx, tc)
				}(toolCall)
				cs.Append(ChatMessage{
					Role:       "tool",
					ToolCallID: toolCall.ID,
					Content:    "Accepted.",
				})
			} else {
				toolResult := a.executeTool(ctx, toolCall)
				cs.Append(toolResult)
			}
		}
	}

	a.compactConversation(ctx, cs)

	finalResponse := strings.TrimSpace(strings.Join(responseParts, "\n\n"))
	if finalResponse == "" {
		finalResponse = "(no text response)"
	}
	a.emitServerEvent(ctx, ServerLogLevelInfo, "agent.turn.completed", "turn completed", map[string]interface{}{
		"duration_ms":      time.Since(turnStartedAt).Milliseconds(),
		"tool_calls_total": toolCallsTotal,
		"response_chars":   len(finalResponse),
		"conversation_len": len(cs.Messages),
	})

	return cs, finalResponse, nil
}

func waitForShutdownSignal(ctx context.Context) {
	select {
	case <-ctx.Done():
		return
	case <-signalChan():
		return
	}
}

func signalChan() <-chan os.Signal {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
	return ch
}

func parseToolArgs(raw string) map[string]interface{} {
	args := map[string]interface{}{}
	if strings.TrimSpace(raw) == "" {
		return args
	}
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		return map[string]interface{}{}
	}
	return args
}

func summarizeToolStart(event ToolEvent) string {
	switch event.ToolName {
	case "read_file":
		return fmt.Sprintf("Reading file: %s", quotedPath(event.ArgsParsed["path"], ""))
	case "list_files":
		return fmt.Sprintf("Listing directory: %s", quotedPath(event.ArgsParsed["path"], "."))
	case "edit_file":
		return fmt.Sprintf("Editing file: %s", quotedPath(event.ArgsParsed["path"], ""))
	case "delegate_reasoning":
		return "Thinking..."
	case "record":
		return "Recording memory..."
	case "recall":
		return "Recalling memories..."
	default:
		return fmt.Sprintf("Calling %s(%s)", event.ToolName, event.ArgsRaw)
	}
}

func summarizeToolSuccess(event ToolEvent) string {
	switch event.ToolName {
	case "read_file":
		pathText := quotedPath(event.ArgsParsed["path"], "")
		return fmt.Sprintf("Read %s (%d bytes, %d lines) in %s", pathText, len(event.ResultRaw), countLines(event.ResultRaw), formatDuration(event.Duration))
	case "list_files":
		pathText := quotedPath(event.ArgsParsed["path"], ".")
		total, files, dirs := summarizeListedEntries(event.ResultRaw)
		return fmt.Sprintf("Listed %s (%d entries: %d files, %d dirs) in %s", pathText, total, files, dirs, formatDuration(event.Duration))
	case "edit_file":
		pathText := quotedPath(event.ArgsParsed["path"], "")
		if strings.HasPrefix(event.ResultRaw, "Successfully created file ") {
			return fmt.Sprintf("Created %s (%d bytes) in %s", pathText, intStat(event.Stats, "create_bytes"), formatDuration(event.Duration))
		}
		return fmt.Sprintf("Edited %s (%d replacements) in %s", pathText, intStat(event.Stats, "replacement_count"), formatDuration(event.Duration))
	case "delegate_reasoning":
		return fmt.Sprintf("Finished thinking (%d chars) in %s", len(event.ResultRaw), formatDuration(event.Duration))
	case "record":
		return fmt.Sprintf("Recorded memory in %s", formatDuration(event.Duration))
	case "recall":
		return fmt.Sprintf("Recalled memories (%d bytes) in %s", len(event.ResultRaw), formatDuration(event.Duration))
	default:
		return fmt.Sprintf("Completed %s in %s", event.ToolName, formatDuration(event.Duration))
	}
}

func summarizeToolFailure(event ToolEvent) string {
	switch event.ToolName {
	case "read_file":
		return fmt.Sprintf("Failed to read %s: %s in %s", quotedPath(event.ArgsParsed["path"], ""), event.Err, formatDuration(event.Duration))
	case "list_files":
		return fmt.Sprintf("Failed to list %s: %s in %s", quotedPath(event.ArgsParsed["path"], "."), event.Err, formatDuration(event.Duration))
	case "edit_file":
		return fmt.Sprintf("Failed to edit %s: %s in %s", quotedPath(event.ArgsParsed["path"], ""), event.Err, formatDuration(event.Duration))
	case "delegate_reasoning":
		return fmt.Sprintf("Reasoning failed: %s in %s", event.Err, formatDuration(event.Duration))
	case "record":
		return fmt.Sprintf("Failed to record memory: %s in %s", event.Err, formatDuration(event.Duration))
	case "recall":
		return fmt.Sprintf("Failed to recall memories: %s in %s", event.Err, formatDuration(event.Duration))
	default:
		if event.Err == "tool not found" {
			return fmt.Sprintf("Tool not found: %s in %s", event.ToolName, formatDuration(event.Duration))
		}
		return fmt.Sprintf("Failed %s: %s in %s", event.ToolName, event.Err, formatDuration(event.Duration))
	}
}

func quotedPath(v interface{}, fallback string) string {
	s, _ := v.(string)
	if strings.TrimSpace(s) == "" {
		s = fallback
	}
	return fmt.Sprintf("%q", s)
}

func countLines(s string) int {
	if s == "" {
		return 0
	}
	return strings.Count(s, "\n") + 1
}

func summarizeListedEntries(raw string) (total int, files int, dirs int) {
	var entries []string
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		return 0, 0, 0
	}
	total = len(entries)
	for _, entry := range entries {
		if strings.HasSuffix(entry, "/") {
			dirs++
			continue
		}
		files++
	}
	return total, files, dirs
}

func formatDuration(d time.Duration) string {
	if d < time.Millisecond {
		return "<1ms"
	}
	return fmt.Sprintf("%dms", d.Milliseconds())
}

func precomputeToolStats(toolName string, args map[string]interface{}) map[string]interface{} {
	stats := map[string]interface{}{}
	if toolName != "edit_file" {
		return stats
	}

	pathVal, _ := args["path"].(string)
	oldStr, _ := args["old_str"].(string)
	newStr, _ := args["new_str"].(string)
	if oldStr == "" {
		stats["create_bytes"] = len(newStr)
		return stats
	}
	content, err := os.ReadFile(pathVal)
	if err != nil {
		return stats
	}
	stats["replacement_count"] = strings.Count(string(content), oldStr)
	return stats
}

func intStat(stats map[string]interface{}, key string) int {
	v, ok := stats[key]
	if !ok {
		return 0
	}
	n, ok := v.(int)
	if !ok {
		return 0
	}
	return n
}

type DelegateReasoningInput struct {
	Question string `json:"question" jsonschema_description:"The question or sub-problem that needs deeper reasoning."`
	Context  string `json:"context,omitempty" jsonschema_description:"Optional compact supporting context for the reasoning task."`
}

var DelegateReasoningInputSchema = GenerateSchema[DelegateReasoningInput]()

func (a *Agent) delegateReasoning(input json.RawMessage) (string, error) {
	if a.reasoningCallCount >= defaultReasoningLimit {
		return "", fmt.Errorf("reasoning call limit reached for this turn")
	}

	payload := DelegateReasoningInput{}
	if err := json.Unmarshal(input, &payload); err != nil {
		return "", err
	}
	if strings.TrimSpace(payload.Question) == "" {
		return "", fmt.Errorf("question is required")
	}

	a.reasoningCallCount++

	reasoningPrompt := strings.TrimSpace(strings.Join([]string{
		"Analyze the question and context and return a concise, actionable answer.",
		"Question:",
		payload.Question,
		"Context:",
		payload.Context,
	}, "\n"))

	timeoutCtx, cancel := context.WithTimeout(context.Background(), reasoningCallTimeout)
	defer cancel()

	spinner := NewStatusIndicator(a.cliOutputWriter(), "delegating reasoning...")
	spinner.Start()
	msg, err := a.runInferenceWithModel(timeoutCtx, a.reasoningModel, []ChatMessage{{
		Role:    "user",
		Content: reasoningPrompt,
	}}, nil, reasoningMaxTokens, PromptModeMinimal, true)
	spinner.Stop()
	if err != nil {
		return "", err
	}

	content, ok := msg.Content.(string)
	if ok && strings.TrimSpace(content) != "" {
		return strings.TrimSpace(content), nil
	}
	if strings.TrimSpace(msg.ReasoningContent) != "" {
		return strings.TrimSpace(msg.ReasoningContent), nil
	}
	if strings.TrimSpace(msg.Reasoning) != "" {
		return strings.TrimSpace(msg.Reasoning), nil
	}
	return "", fmt.Errorf("reasoning model returned no usable text output")
}

func GenerateSchema[T any]() map[string]interface{} {
	reflector := jsonschema.Reflector{
		AllowAdditionalProperties: false,
		DoNotReference:            true,
	}
	var v T
	schema := reflector.Reflect(v)

	schemaJSON, err := json.Marshal(schema)
	if err != nil {
		return map[string]interface{}{"type": "object"}
	}

	result := map[string]interface{}{}
	if err := json.Unmarshal(schemaJSON, &result); err != nil {
		return map[string]interface{}{"type": "object"}
	}
	return result
}

var ReadFileDefinition = ToolDefinition{
	Name:        "read_file",
	Description: "Read the contents of a given relative file path. Use this when you want to see what's inside a file. Do not use this with directory names.",
	InputSchema: ReadFileInputSchema,
	Function:    ReadFile,
}

type ReadFileInput struct {
	Path string `json:"path" jsonschema_description:"The relative path of a file in the working directory."`
}

var ReadFileInputSchema = GenerateSchema[ReadFileInput]()

func ReadFile(input json.RawMessage) (string, error) {
	readFileInput := ReadFileInput{}
	if err := json.Unmarshal(input, &readFileInput); err != nil {
		return "", err
	}

	content, err := os.ReadFile(readFileInput.Path)
	if err != nil {
		return "", err
	}
	return string(content), nil
}

var ListFilesDefinition = ToolDefinition{
	Name:        "list_files",
	Description: "List files and directories at a given path (non-recursive). If no path is provided, lists files in the current directory.",
	InputSchema: ListFilesInputSchema,
	Function:    ListFiles,
}

type ListFilesInput struct {
	Path string `json:"path,omitempty" jsonschema_description:"Optional relative path to list files from. Defaults to current directory if not provided."`
}

var ListFilesInputSchema = GenerateSchema[ListFilesInput]()

func ListFiles(input json.RawMessage) (string, error) {
	listFilesInput := ListFilesInput{}
	if err := json.Unmarshal(input, &listFilesInput); err != nil {
		return "", err
	}

	dir := "."
	if listFilesInput.Path != "" {
		dir = listFilesInput.Path
	}

	var files []string
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() {
			files = append(files, name+"/")
		} else {
			files = append(files, name)
		}
	}

	result, err := json.Marshal(files)
	if err != nil {
		return "", err
	}
	return string(result), nil
}

var EditFileDefinition = ToolDefinition{
	Name: "edit_file",
	Description: `Make edits to a text file.

Replaces 'old_str' with 'new_str' in the given file. 'old_str' and 'new_str' MUST be different from each other.

If the file specified with path doesn't exist, it will be created.`,
	InputSchema: EditFileInputSchema,
	Function:    EditFile,
}

type EditFileInput struct {
	Path   string `json:"path" jsonschema_description:"The path to the file"`
	OldStr string `json:"old_str" jsonschema_description:"Text to search for - must match exactly and must only have one match exactly"`
	NewStr string `json:"new_str" jsonschema_description:"Text to replace old_str with"`
}

var EditFileInputSchema = GenerateSchema[EditFileInput]()

func EditFile(input json.RawMessage) (string, error) {
	editFileInput := EditFileInput{}
	if err := json.Unmarshal(input, &editFileInput); err != nil {
		return "", err
	}

	if editFileInput.Path == "" || editFileInput.OldStr == editFileInput.NewStr {
		return "", fmt.Errorf("invalid input parameters")
	}

	content, err := os.ReadFile(editFileInput.Path)
	if err != nil {
		if os.IsNotExist(err) && editFileInput.OldStr == "" {
			return createNewFile(editFileInput.Path, editFileInput.NewStr)
		}
		return "", err
	}

	oldContent := string(content)
	newContent := strings.Replace(oldContent, editFileInput.OldStr, editFileInput.NewStr, -1)
	if oldContent == newContent && editFileInput.OldStr != "" {
		return "", fmt.Errorf("old_str not found in file")
	}

	if err := os.WriteFile(editFileInput.Path, []byte(newContent), 0o644); err != nil {
		return "", err
	}
	return "OK", nil
}

func createNewFile(filePath, content string) (string, error) {
	dir := filepath.Dir(filePath)
	if dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", fmt.Errorf("failed to create directory: %w", err)
		}
	}

	if err := os.WriteFile(filePath, []byte(content), 0o644); err != nil {
		return "", fmt.Errorf("failed to create file: %w", err)
	}
	return fmt.Sprintf("Successfully created file %s", filePath), nil
}
