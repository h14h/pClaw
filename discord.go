package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/bwmarrin/discordgo"
)

const (
	discordCommandName        = "agent"
	discordPromptOptionName   = "prompt"
	discordMessageLimit       = 2000
	discordMessageChunkTarget = 1900
)

type discordSessionState struct {
	mu           sync.Mutex
	agent        *Agent
	conversation []ChatMessage
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

func (m *discordSessionManager) get(sessionKey string) *discordSessionState {
	m.mu.Lock()
	defer m.mu.Unlock()

	state, ok := m.sessions[sessionKey]
	if ok {
		return state
	}

	state = &discordSessionState{agent: m.newAgent()}
	m.sessions[sessionKey] = state
	return state
}

func runDiscordBot(ctx context.Context) error {
	apiKey := strings.TrimSpace(os.Getenv("VULTR_API_KEY"))
	if apiKey == "" {
		return fmt.Errorf("VULTR_API_KEY is required")
	}

	baseURL := strings.TrimSpace(os.Getenv("VULTR_BASE_URL"))
	if baseURL == "" {
		baseURL = defaultVultrBaseURL
	}
	baseURL = strings.TrimRight(baseURL, "/")

	token := strings.TrimSpace(os.Getenv("DISCORD_BOT_TOKEN"))
	if token == "" {
		return fmt.Errorf("DISCORD_BOT_TOKEN is required")
	}

	applicationID := strings.TrimSpace(os.Getenv("DISCORD_APPLICATION_ID"))
	guildID := strings.TrimSpace(os.Getenv("DISCORD_GUILD_ID"))
	allowedChannelIDs := csvToSet(os.Getenv("DISCORD_ALLOWED_CHANNEL_IDS"))
	allowedUserIDs := csvToSet(os.Getenv("DISCORD_ALLOWED_USER_IDS"))

	manager := newDiscordSessionManager(func() *Agent {
		agent := NewAgent(baseURL, apiKey, http.DefaultClient, nil, nil)
		agent.setOutputWriter(io.Discard)
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

		userID := interactionUserID(i)
		if !isAllowedDiscordRequest(i.ChannelID, userID, allowedChannelIDs, allowedUserIDs) {
			respondInteractionError(s, i.Interaction, "You are not allowed to use this bot here.")
			return
		}

		prompt := commandStringOption(i.ApplicationCommandData().Options, discordPromptOptionName)
		if strings.TrimSpace(prompt) == "" {
			respondInteractionError(s, i.Interaction, "Prompt is required.")
			return
		}

		err := s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
			Type: discordgo.InteractionResponseDeferredChannelMessageWithSource,
			Data: &discordgo.InteractionResponseData{},
		})
		if err != nil {
			return
		}

		response, runErr := runDiscordPrompt(ctx, manager, i.ChannelID, userID, prompt)
		if runErr != nil {
			errText := "Agent error: " + runErr.Error()
			_, _ = s.InteractionResponseEdit(i.Interaction, &discordgo.WebhookEdit{Content: &errText})
			return
		}

		chunks := splitForDiscord(response)
		if len(chunks) == 0 {
			chunks = []string{"(empty response)"}
		}

		_, _ = s.InteractionResponseEdit(i.Interaction, &discordgo.WebhookEdit{Content: &chunks[0]})
		for _, chunk := range chunks[1:] {
			_, _ = s.FollowupMessageCreate(i.Interaction, false, &discordgo.WebhookParams{Content: chunk})
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
		if !messageMentionsUser(m.Message, botUserID) {
			return
		}
		if !isAllowedDiscordRequest(m.ChannelID, m.Author.ID, allowedChannelIDs, allowedUserIDs) {
			return
		}

		prompt := promptFromMention(m.Content, botUserID)
		if prompt == "" {
			return
		}

		_ = s.ChannelTyping(m.ChannelID)
		response, err := runDiscordPrompt(ctx, manager, m.ChannelID, m.Author.ID, prompt)
		if err != nil {
			_, _ = s.ChannelMessageSendReply(m.ChannelID, "Agent error: "+err.Error(), m.Reference())
			return
		}

		chunks := splitForDiscord(response)
		if len(chunks) == 0 {
			chunks = []string{"(empty response)"}
		}
		for idx, chunk := range chunks {
			if idx == 0 {
				_, _ = s.ChannelMessageSendReply(m.ChannelID, chunk, m.Reference())
				continue
			}
			_, _ = s.ChannelMessageSend(m.ChannelID, chunk)
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
	sessionKey := discordConversationKey(channelID, userID)
	state := manager.get(sessionKey)

	state.mu.Lock()
	defer state.mu.Unlock()

	updatedConversation, response, err := state.agent.HandleUserMessage(ctx, state.conversation, prompt)
	if err != nil {
		return "", err
	}
	state.conversation = updatedConversation
	return response, nil
}

func splitForDiscord(text string) []string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil
	}

	var chunks []string
	remaining := trimmed
	for len(remaining) > discordMessageLimit {
		splitAt := strings.LastIndex(remaining[:discordMessageChunkTarget], "\n")
		if splitAt <= 0 {
			splitAt = discordMessageChunkTarget
		}
		chunks = append(chunks, strings.TrimSpace(remaining[:splitAt]))
		remaining = strings.TrimSpace(remaining[splitAt:])
	}
	if remaining != "" {
		chunks = append(chunks, remaining)
	}
	return chunks
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

func respondInteractionError(s *discordgo.Session, interaction *discordgo.Interaction, message string) {
	_ = s.InteractionRespond(interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{Content: message},
	})
}
