package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/bwmarrin/discordgo"
)

const (
	discordCommandName      = "agent"
	discordPromptOptionName = "prompt"
	discordMessageLimit     = 2000
	discordSplitMarker      = "<<MSG_SPLIT>>"
	discordTypingInterval   = 8 * time.Second

	discordBotInvitePermissions = 563465349975104
)

type discordSessionState struct {
	mu    sync.Mutex
	agent *Agent
	cs    *ConversationState
}

type discordSessionManager struct {
	mu       sync.Mutex
	sessions map[string]*discordSessionState
	newAgent func() *Agent
}

func newDiscordSessionManager(newAgent func() *Agent) *discordSessionManager {
	return &discordSessionManager{
		sessions: map[string]*discordSessionState{},
		newAgent: newAgent,
	}
}

func (m *discordSessionManager) get(sessionKey string) (*discordSessionState, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	state, ok := m.sessions[sessionKey]
	if ok {
		return state, false
	}

	state = &discordSessionState{agent: m.newAgent(), cs: NewConversationState()}
	m.sessions[sessionKey] = state
	return state, true
}

func runDiscordBot(ctx context.Context, cfg *ResolvedConfig) error {
	baseURL := strings.TrimRight(cfg.Provider.BaseURL, "/")
	apiKey := cfg.Provider.APIKey
	if apiKey == "" && baseURL == defaultVultrBaseURL {
		return fmt.Errorf("API key is required (set via the env var named in api_key_env)")
	}

	token := cfg.Discord.BotToken
	if token == "" {
		return fmt.Errorf("Discord bot token is required (set via the env var named in bot_token_env)")
	}

	applicationID := strings.TrimSpace(cfg.Discord.ApplicationID)
	guildID := strings.TrimSpace(cfg.Discord.GuildID)
	allowedChannelIDs := cfg.Discord.AllowedChannelSet
	allowedUserIDs := cfg.Discord.AllowedUserSet
	serverEventSink := newServerEventSinkFromEnv(os.Stdout)

	// Create a single shared MemoryClient for all Discord session agents.
	// Sharing avoids redundant EnsureCollection round-trips and keeps the
	// same collection ID across agents in this process.
	var sharedMemClient *MemoryClient
	if cfg.Config.Memory.Enabled {
		colName := cfg.Config.Memory.CollectionName
		if colName == "" {
			colName = defaultMemoryCollectionName
		}
		client := NewMemoryClient(baseURL, apiKey, http.DefaultClient)
		if err := client.EnsureCollection(ctx, colName); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: memory initialization failed, running without memory: %v\n", err)
		} else {
			sharedMemClient = client
		}
	}

	manager := newDiscordSessionManager(func() *Agent {
		agent := NewAgent(baseURL, apiKey, http.DefaultClient, nil, nil, cfg)
		agent.setOutputWriter(io.Discard)
		agent.setPromptTransport("discord")
		agent.serverEventSink = serverEventSink
		if sharedMemClient != nil {
			agent.memoryClient = sharedMemClient
		}
		configureWebSearch(agent, cfg)
		// Rebuild tools after all clients are set. configureWebSearch
		// rebuilds when the API key is present, but we need a rebuild
		// when only memoryClient was set and web search is absent.
		if agent.webSearchClient == nil && sharedMemClient != nil {
			agent.tools = agent.buildTools(nil)
		}
		return agent
	})

	dg, err := discordgo.New("Bot " + token)
	if err != nil {
		return fmt.Errorf("create discord session: %w", err)
	}
	dg.Identify.Intents = discordgo.IntentsGuilds | discordgo.IntentsGuildMessages | discordgo.IntentsDirectMessages | discordgo.IntentsMessageContent

	dg.AddHandler(func(s *discordgo.Session, i *discordgo.InteractionCreate) {
		if i.Type != discordgo.InteractionApplicationCommand {
			return
		}
		if i.ApplicationCommandData().Name != discordCommandName {
			return
		}

		interactionID := ""
		if i.Interaction != nil {
			interactionID = i.Interaction.ID
		}

		userID := interactionUserID(i)
		sessionKey := discordConversationKey(i.ChannelID, userID)
		eventCtx := withServerLogMeta(ctx, serverLogMeta{
			TraceID:       nextServerEventID("trc"),
			TurnID:        nextServerEventID("turn"),
			SessionKey:    sessionKey,
			Source:        "discord",
			ChannelID:     i.ChannelID,
			UserIDHash:    hashIdentifier(userID),
			InteractionID: interactionID,
		})
		emitServerEventWithSink(eventCtx, serverEventSink, ServerLogLevelInfo, "discord.request.received", "discord slash command received", map[string]interface{}{
			"source":       "slash",
			"command_name": i.ApplicationCommandData().Name,
		})

		if !isAllowedDiscordRequest(i.ChannelID, userID, allowedChannelIDs, allowedUserIDs) {
			emitServerEventWithSink(eventCtx, serverEventSink, ServerLogLevelWarn, "discord.request.rejected", "discord request rejected", map[string]interface{}{
				"reason": "not_allowed",
				"source": "slash",
			})
			respondInteractionError(s, i.Interaction, "You are not allowed to use this bot here.")
			return
		}

		prompt := commandStringOption(i.ApplicationCommandData().Options, discordPromptOptionName)
		if strings.TrimSpace(prompt) == "" {
			emitServerEventWithSink(eventCtx, serverEventSink, ServerLogLevelWarn, "discord.request.rejected", "discord request rejected", map[string]interface{}{
				"reason": "empty_prompt",
				"source": "slash",
			})
			respondInteractionError(s, i.Interaction, "Prompt is required.")
			return
		}
		emitServerEventWithSink(eventCtx, serverEventSink, ServerLogLevelInfo, "discord.request.accepted", "discord request accepted", map[string]interface{}{
			"source":       "slash",
			"prompt_chars": len(prompt),
		})

		err := s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
			Type: discordgo.InteractionResponseDeferredChannelMessageWithSource,
			Data: &discordgo.InteractionResponseData{},
		})
		if err != nil {
			return
		}
		stopTyping := startTypingHeartbeat(ctx, discordTypingInterval, func() {
			_ = s.ChannelTyping(i.ChannelID)
		})
		defer stopTyping()

		sender := &progressiveDiscordSender{
			sendFirst: func(content string) error {
				_, err := s.InteractionResponseEdit(i.Interaction, &discordgo.WebhookEdit{Content: &content})
				return err
			},
			sendNext: func(content string) error {
				_, err := s.FollowupMessageCreate(i.Interaction, false, &discordgo.WebhookParams{Content: content})
				return err
			},
		}

		response, runErr := runDiscordPromptProgressive(eventCtx, serverEventSink, manager, i.ChannelID, userID, prompt, sender.SendPart)
		if runErr != nil {
			emitServerEventWithSink(eventCtx, serverEventSink, ServerLogLevelError, "discord.request.failed", "discord request failed", map[string]interface{}{
				"source": "slash",
				"error":  runErr.Error(),
			})
			errText := "Agent error: " + runErr.Error()
			_, _ = s.InteractionResponseEdit(i.Interaction, &discordgo.WebhookEdit{Content: &errText})
			return
		}

		if !sender.sent {
			fallback := response
			if strings.TrimSpace(fallback) == "" {
				fallback = "(empty response)"
			}
			_ = sender.SendPart(fallback)
		}
	})

	dg.AddHandler(func(s *discordgo.Session, m *discordgo.MessageCreate) {
		if m == nil || m.Author == nil || m.Author.Bot {
			return
		}
		if dg.State == nil || dg.State.User == nil {
			return
		}
		botUserID := dg.State.User.ID
		isDM := isDMChannel(s, m.ChannelID)
		if !isDM && !messageMentionsUser(m.Message, botUserID) {
			return
		}

		if isDM && containsDiscordInvite(m.Content) {
			url := botInviteURL(applicationID, discordBotInvitePermissions)
			_, _ = s.ChannelMessageSendReply(m.ChannelID, "To add me to your server, use this link:\n"+url, m.Reference())
			return
		}

		sessionKey := discordConversationKey(m.ChannelID, m.Author.ID)
		source := "mention"
		if isDM {
			source = "dm"
		}
		eventCtx := withServerLogMeta(ctx, serverLogMeta{
			TraceID:    nextServerEventID("trc"),
			TurnID:     nextServerEventID("turn"),
			SessionKey: sessionKey,
			Source:     "discord",
			ChannelID:  m.ChannelID,
			UserIDHash: hashIdentifier(m.Author.ID),
			MessageID:  m.ID,
		})
		emitServerEventWithSink(eventCtx, serverEventSink, ServerLogLevelInfo, "discord.request.received", "discord message received", map[string]interface{}{
			"source": source,
		})
		if !isAllowedDiscordRequest(m.ChannelID, m.Author.ID, allowedChannelIDs, allowedUserIDs) {
			emitServerEventWithSink(eventCtx, serverEventSink, ServerLogLevelWarn, "discord.request.rejected", "discord request rejected", map[string]interface{}{
				"reason": "not_allowed",
				"source": source,
			})
			return
		}

		var prompt string
		if isDM {
			prompt = strings.TrimSpace(m.Content)
		} else {
			prompt = promptFromMention(m.Content, botUserID)
		}
		if prompt == "" {
			emitServerEventWithSink(eventCtx, serverEventSink, ServerLogLevelWarn, "discord.request.rejected", "discord request rejected", map[string]interface{}{
				"reason": "empty_prompt",
				"source": source,
			})
			return
		}
		emitServerEventWithSink(eventCtx, serverEventSink, ServerLogLevelInfo, "discord.request.accepted", "discord request accepted", map[string]interface{}{
			"source":       source,
			"prompt_chars": len(prompt),
		})

		_ = s.ChannelTyping(m.ChannelID)
		stopTyping := startTypingHeartbeat(ctx, discordTypingInterval, func() {
			_ = s.ChannelTyping(m.ChannelID)
		})
		defer stopTyping()
		sender := &progressiveDiscordSender{
			sendFirst: func(content string) error {
				_, err := s.ChannelMessageSendReply(m.ChannelID, content, m.Reference())
				return err
			},
			sendNext: func(content string) error {
				_, err := s.ChannelMessageSend(m.ChannelID, content)
				return err
			},
		}
		response, err := runDiscordPromptProgressive(eventCtx, serverEventSink, manager, m.ChannelID, m.Author.ID, prompt, sender.SendPart)
		if err != nil {
			emitServerEventWithSink(eventCtx, serverEventSink, ServerLogLevelError, "discord.request.failed", "discord request failed", map[string]interface{}{
				"source": source,
				"error":  err.Error(),
			})
			_, _ = s.ChannelMessageSendReply(m.ChannelID, "Agent error: "+err.Error(), m.Reference())
			return
		}

		if !sender.sent {
			fallback := response
			if strings.TrimSpace(fallback) == "" {
				fallback = "(empty response)"
			}
			_ = sender.SendPart(fallback)
		}
	})

	if err := dg.Open(); err != nil {
		return fmt.Errorf("open discord session: %w", err)
	}
	defer dg.Close()

	if applicationID == "" && dg.State != nil && dg.State.User != nil {
		applicationID = dg.State.User.ID
	}
	if applicationID == "" {
		return fmt.Errorf("DISCORD_APPLICATION_ID is required when application id cannot be inferred")
	}

	command := &discordgo.ApplicationCommand{
		Name:        discordCommandName,
		Description: "Send a prompt to the coding agent",
		Options: []*discordgo.ApplicationCommandOption{{
			Type:        discordgo.ApplicationCommandOptionString,
			Name:        discordPromptOptionName,
			Description: "What you want the agent to do",
			Required:    true,
		}},
	}

	if _, err := dg.ApplicationCommandCreate(applicationID, guildID, command); err != nil {
		return fmt.Errorf("register slash command: %w", err)
	}

	fmt.Printf("Discord bot is running. Registered /%s command and mention chat.\n", discordCommandName)
	waitForShutdownSignal(ctx)
	return nil
}

func commandStringOption(options []*discordgo.ApplicationCommandInteractionDataOption, name string) string {
	for _, opt := range options {
		if opt.Name == name {
			value, _ := opt.Value.(string)
			return value
		}
	}
	return ""
}

func discordConversationKey(channelID, userID string) string {
	if channelID == "" {
		channelID = "default"
	}
	if userID == "" {
		userID = "anonymous"
	}
	return channelID + ":" + userID
}

func interactionUserID(i *discordgo.InteractionCreate) string {
	if i == nil {
		return ""
	}
	if i.Member != nil && i.Member.User != nil {
		return i.Member.User.ID
	}
	if i.User != nil {
		return i.User.ID
	}
	return ""
}

func isAllowedDiscordRequest(channelID, userID string, allowedChannelIDs, allowedUserIDs map[string]struct{}) bool {
	if len(allowedChannelIDs) > 0 {
		if _, ok := allowedChannelIDs[channelID]; !ok {
			return false
		}
	}
	if len(allowedUserIDs) > 0 {
		if _, ok := allowedUserIDs[userID]; !ok {
			return false
		}
	}
	return true
}

func isDMChannel(s *discordgo.Session, channelID string) bool {
	ch, err := s.State.Channel(channelID)
	if err != nil {
		ch, err = s.Channel(channelID)
		if err != nil {
			return false
		}
	}
	return ch.Type == discordgo.ChannelTypeDM || ch.Type == discordgo.ChannelTypeGroupDM
}

func messageMentionsUser(message *discordgo.Message, userID string) bool {
	if message == nil || userID == "" {
		return false
	}
	for _, mention := range message.Mentions {
		if mention != nil && mention.ID == userID {
			return true
		}
	}
	return false
}

func promptFromMention(content, botUserID string) string {
	if strings.TrimSpace(content) == "" || strings.TrimSpace(botUserID) == "" {
		return ""
	}
	content = strings.ReplaceAll(content, "<@"+botUserID+">", "")
	content = strings.ReplaceAll(content, "<@!"+botUserID+">", "")
	return strings.TrimSpace(content)
}

func runDiscordPrompt(ctx context.Context, manager *discordSessionManager, channelID, userID, prompt string) (string, error) {
	return runDiscordPromptProgressive(ctx, nil, manager, channelID, userID, prompt, nil)
}

func runDiscordPromptProgressive(
	ctx context.Context,
	serverEventSink ServerEventSink,
	manager *discordSessionManager,
	channelID, userID, prompt string,
	onResponsePart func(part string) error,
) (string, error) {
	requestStartedAt := time.Now()
	sessionKey := discordConversationKey(channelID, userID)
	state, isNew := manager.get(sessionKey)

	state.mu.Lock()
	defer state.mu.Unlock()
	emitServerEventWithSink(ctx, serverEventSink, ServerLogLevelInfo, "discord.session.resolved", "session resolved", map[string]interface{}{
		"is_new":           isNew,
		"conversation_len": len(state.cs.Messages),
	})

	partIndex := 0
	totalParts := 0
	totalChunks := 0
	totalChars := 0
	globalChunkIndex := 0
	verboseContentLogs := serverEventSinkIncludesVerboseContent(serverEventSink)
	wrappedOnResponsePart := func(part string) error {
		chunks := splitForDiscord(part)
		totalParts++
		totalChunks += len(chunks)
		totalChars += len(part)
		if verboseContentLogs {
			emitServerEventWithSink(ctx, serverEventSink, ServerLogLevelInfo, "discord.response.part_content", "response part content", map[string]interface{}{
				"part_index": partIndex,
				"chars":      len(part),
				"content":    part,
			})
			for chunkIndex, chunk := range chunks {
				emitServerEventWithSink(ctx, serverEventSink, ServerLogLevelInfo, "discord.response.chunk_content", "response chunk content", map[string]interface{}{
					"part_index":         partIndex,
					"chunk_index":        chunkIndex,
					"global_chunk_index": globalChunkIndex,
					"chars":              len(chunk),
					"content":            chunk,
				})
				globalChunkIndex++
			}
		}
		if onResponsePart != nil {
			if err := onResponsePart(part); err != nil {
				emitServerEventWithSink(ctx, serverEventSink, ServerLogLevelError, "discord.response.failed", "response send failed", map[string]interface{}{
					"duration_ms": time.Since(requestStartedAt).Milliseconds(),
					"part_index":  partIndex,
					"error":       err.Error(),
				})
				return err
			}
		}
		emitServerEventWithSink(ctx, serverEventSink, ServerLogLevelInfo, "discord.response.part_sent", "response chunk sent", map[string]interface{}{
			"part_index": partIndex,
			"chars":      len(part),
			"chunks":     len(chunks),
		})
		partIndex++
		return nil
	}

	updatedCS, response, err := state.agent.HandleUserMessageProgressive(ctx, state.cs, prompt, wrappedOnResponsePart)
	if err != nil {
		emitServerEventWithSink(ctx, serverEventSink, ServerLogLevelError, "discord.response.failed", "response failed", map[string]interface{}{
			"duration_ms": time.Since(requestStartedAt).Milliseconds(),
			"error":       err.Error(),
		})
		return "", err
	}
	state.cs = updatedCS
	completedFields := map[string]interface{}{
		"duration_ms":  time.Since(requestStartedAt).Milliseconds(),
		"total_parts":  totalParts,
		"total_chunks": totalChunks,
		"total_chars":  totalChars,
	}
	if verboseContentLogs {
		completedFields["content"] = response
	}
	emitServerEventWithSink(ctx, serverEventSink, ServerLogLevelInfo, "discord.response.completed", "response completed", completedFields)
	return response, nil
}

type progressiveDiscordSender struct {
	sendFirst func(string) error
	sendNext  func(string) error
	sent      bool
}

func (s *progressiveDiscordSender) SendPart(part string) error {
	for _, chunk := range splitForDiscord(part) {
		if !s.sent {
			if err := s.sendFirst(chunk); err != nil {
				return err
			}
			s.sent = true
			continue
		}
		if err := s.sendNext(chunk); err != nil {
			return err
		}
	}
	return nil
}

func splitForDiscord(text string) []string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil
	}

	if strings.Contains(trimmed, discordSplitMarker) {
		parts := strings.Split(trimmed, discordSplitMarker)
		chunks := make([]string, 0, len(parts))
		for _, part := range parts {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			chunks = append(chunks, splitForDiscordBalanced(part)...)
		}
		if len(chunks) > 0 {
			return chunks
		}
	}

	return splitForDiscordBalanced(trimmed)
}

func splitForDiscordBalanced(text string) []string {
	var chunks []string
	remaining := text
	for len(remaining) > discordMessageLimit {
		chunkCount := (len(remaining) + discordMessageLimit - 1) / discordMessageLimit
		target := len(remaining) / chunkCount
		splitAt := findBalancedSplitPoint(remaining, target, discordMessageLimit)
		chunks = append(chunks, strings.TrimSpace(remaining[:splitAt]))
		remaining = strings.TrimSpace(remaining[splitAt:])
	}
	if remaining != "" {
		chunks = append(chunks, remaining)
	}
	return chunks
}

func findBalancedSplitPoint(text string, target, hardLimit int) int {
	if hardLimit <= 0 {
		return len(text)
	}
	if len(text) <= hardLimit {
		return len(text)
	}
	if target <= 0 || target > hardLimit {
		target = hardLimit
	}

	searchEnd := hardLimit
	window := target / 4
	if window < 120 {
		window = 120
	}
	if window > 500 {
		window = 500
	}
	searchStart := target - window
	if searchStart < 1 {
		searchStart = 1
	}
	searchWindowEnd := target + window
	if searchWindowEnd > searchEnd {
		searchWindowEnd = searchEnd
	}

	candidate := text[:searchEnd]
	for _, delimiter := range []string{"\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " "} {
		if idx := closestSplitAfterDelimiter(candidate, delimiter, searchStart, searchWindowEnd, target); idx > 0 {
			return idx
		}
	}

	return target
}

func closestSplitAfterDelimiter(text, delimiter string, start, end, target int) int {
	if delimiter == "" || start >= end || start < 0 || end > len(text) {
		return -1
	}

	bestIndex := -1
	bestDistance := 0
	searchFrom := 0
	for {
		idx := strings.Index(text[searchFrom:], delimiter)
		if idx < 0 {
			break
		}
		idx += searchFrom
		splitAt := idx + len(delimiter)
		searchFrom = idx + 1

		if splitAt < start || splitAt > end {
			continue
		}
		distance := splitAt - target
		if distance < 0 {
			distance = -distance
		}
		if bestIndex == -1 || distance < bestDistance {
			bestIndex = splitAt
			bestDistance = distance
		}
	}
	return bestIndex
}

func csvToSet(raw string) map[string]struct{} {
	parts := strings.Split(raw, ",")
	out := map[string]struct{}{}
	for _, part := range parts {
		value := strings.TrimSpace(part)
		if value == "" {
			continue
		}
		out[value] = struct{}{}
	}
	return out
}

func containsDiscordInvite(text string) bool {
	lower := strings.ToLower(text)
	return strings.Contains(lower, "discord.gg/") ||
		strings.Contains(lower, "discord.com/invite/") ||
		strings.Contains(lower, "discordapp.com/invite/")
}

func botInviteURL(appID string, permissions int) string {
	return fmt.Sprintf("https://discord.com/oauth2/authorize?client_id=%s&scope=bot+applications.commands&permissions=%d", appID, permissions)
}

func respondInteractionError(s *discordgo.Session, interaction *discordgo.Interaction, message string) {
	_ = s.InteractionRespond(interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{Content: message},
	})
}

func startTypingHeartbeat(ctx context.Context, interval time.Duration, send func()) func() {
	if send == nil {
		return func() {}
	}
	if interval <= 0 {
		interval = discordTypingInterval
	}

	heartbeatCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-heartbeatCtx.Done():
				return
			case <-ticker.C:
				send()
			}
		}
	}()

	return func() {
		cancel()
		<-done
	}
}
