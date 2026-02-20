package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"strings"

	"github.com/invopop/jsonschema"
)

const (
	defaultVultrBaseURL = "https://api.vultrinference.com/v1"
	defaultVultrModel   = "kimi-k2-instruct"
)

type ToolDefinition struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	InputSchema map[string]interface{} `json:"input_schema"`
	Function    func(input json.RawMessage) (string, error)
}

type Agent struct {
	baseURL        string
	apiKey         string
	model          string
	httpClient     *http.Client
	getUserMessage func() (string, bool)
	tools          []ToolDefinition
}

type ChatMessage struct {
	Role       string         `json:"role"`
	Content    interface{}    `json:"content,omitempty"`
	ToolCalls  []ChatToolCall `json:"tool_calls,omitempty"`
	ToolCallID string         `json:"tool_call_id,omitempty"`
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

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	getUserMessage := func() (string, bool) {
		if !scanner.Scan() {
			return "", false
		}
		return scanner.Text(), true
	}

	tools := []ToolDefinition{
		ReadFileDefinition,
		ListFilesDefinition,
		EditFileDefinition,
	}

	apiKey := os.Getenv("VULTR_API_KEY")
	if apiKey == "" {
		fmt.Println("Error: VULTR_API_KEY is required")
		os.Exit(1)
	}

	model := os.Getenv("VULTR_MODEL")
	if model == "" {
		model = defaultVultrModel
	}

	baseURL := os.Getenv("VULTR_BASE_URL")
	if baseURL == "" {
		baseURL = defaultVultrBaseURL
	}
	baseURL = strings.TrimRight(baseURL, "/")

	agent := NewAgent(baseURL, apiKey, model, http.DefaultClient, getUserMessage, tools)
	if err := agent.Run(context.Background()); err != nil {
		fmt.Printf("Error: %s\n", err.Error())
	}
}

func NewAgent(
	baseURL, apiKey, model string,
	httpClient *http.Client,
	getUserMessage func() (string, bool),
	tools []ToolDefinition,
) *Agent {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &Agent{
		baseURL:        baseURL,
		apiKey:         apiKey,
		model:          model,
		httpClient:     httpClient,
		getUserMessage: getUserMessage,
		tools:          tools,
	}
}

func (a *Agent) Run(ctx context.Context) error {
	conversation := []ChatMessage{}

	fmt.Println("Chat with Vultr Inference (use 'ctrl-c' to quit)")

	readUserInput := true
	for {
		if readUserInput {
			fmt.Print("\u001b[94mYou\u001b[0m: ")
			userInput, ok := a.getUserMessage()
			if !ok {
				break
			}
			userMessage := ChatMessage{
				Role:    "user",
				Content: userInput,
			}
			conversation = append(conversation, userMessage)
		}

		message, err := a.runInference(ctx, conversation)
		if err != nil {
			return err
		}
		conversation = append(conversation, message)

		if text, ok := message.Content.(string); ok && text != "" {
			fmt.Printf("\u001b[93mAssistant\u001b[0m: %s\n", text)
		}

		if len(message.ToolCalls) == 0 {
			readUserInput = true
			continue
		}

		for _, toolCall := range message.ToolCalls {
			toolResult := a.executeTool(toolCall)
			conversation = append(conversation, toolResult)
		}
		readUserInput = false
	}

	return nil
}

func (a *Agent) runInference(ctx context.Context, conversation []ChatMessage) (ChatMessage, error) {
	tools := []ChatTool{}
	for _, tool := range a.tools {
		tools = append(tools, ChatTool{
			Type: "function",
			Function: ChatToolFunction{
				Name:        tool.Name,
				Description: tool.Description,
				Parameters:  tool.InputSchema,
			},
		})
	}

	requestBody := ChatCompletionRequest{
		Model:     a.model,
		MaxTokens: 1024,
		Messages:  conversation,
		Tools:     tools,
	}
	if len(tools) > 0 {
		requestBody.ToolChoice = "auto"
	}

	body, err := json.Marshal(requestBody)
	if err != nil {
		return ChatMessage{}, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return ChatMessage{}, err
	}
	req.Header.Set("Authorization", "Bearer "+a.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := a.httpClient.Do(req)
	if err != nil {
		return ChatMessage{}, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return ChatMessage{}, err
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ChatMessage{}, fmt.Errorf("vultr api error (%d): %s", resp.StatusCode, string(respBody))
	}

	var completion ChatCompletionResponse
	if err := json.Unmarshal(respBody, &completion); err != nil {
		return ChatMessage{}, err
	}

	if completion.Error != nil && completion.Error.Message != "" {
		return ChatMessage{}, fmt.Errorf("vultr api error: %s", completion.Error.Message)
	}

	if len(completion.Choices) == 0 {
		return ChatMessage{}, fmt.Errorf("vultr api returned no choices")
	}

	return completion.Choices[0].Message, nil
}

func (a *Agent) executeTool(toolCall ChatToolCall) ChatMessage {
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

	fmt.Printf("\u001b[92mtool\u001b[0m: %s(%s)\n", toolCall.Function.Name, rawInput)
	response, err := toolDef.Function(rawInput)
	if err != nil {
		return ChatMessage{
			Role:       "tool",
			ToolCallID: toolCall.ID,
			Content:    err.Error(),
		}
	}
	return ChatMessage{
		Role:       "tool",
		ToolCallID: toolCall.ID,
		Content:    response,
	}
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
	dir := path.Dir(filePath)
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
