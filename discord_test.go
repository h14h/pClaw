package main

import (
	"strings"
	"testing"

	"github.com/bwmarrin/discordgo"
)

func TestSplitForDiscord(t *testing.T) {
	text := strings.Repeat("a", discordMessageLimit+150)
	chunks := splitForDiscord(text)
	if len(chunks) < 2 {
		t.Fatalf("expected multiple chunks, got %d", len(chunks))
	}
	for i, chunk := range chunks {
		if len(chunk) > discordMessageLimit {
			t.Fatalf("chunk %d exceeds discord limit: %d", i, len(chunk))
		}
	}
}

func TestDiscordConversationKey(t *testing.T) {
	key := discordConversationKey("chan_1", "user_1")
	if key != "chan_1:user_1" {
		t.Fatalf("expected key chan_1:user_1, got %q", key)
	}
}

func TestPromptFromMention(t *testing.T) {
	prompt := promptFromMention("<@12345> fix this file", "12345")
	if prompt != "fix this file" {
		t.Fatalf("expected mention prompt to be cleaned, got %q", prompt)
	}
}

func TestMessageMentionsUser(t *testing.T) {
	msg := &discordgo.Message{
		Mentions: []*discordgo.User{{ID: "u1"}, {ID: "u2"}},
	}
	if !messageMentionsUser(msg, "u2") {
		t.Fatal("expected mention match")
	}
	if messageMentionsUser(msg, "u3") {
		t.Fatal("unexpected mention match")
	}
}

func TestCSVToSet(t *testing.T) {
	set := csvToSet(" a, ,b,c ")
	if len(set) != 3 {
		t.Fatalf("expected 3 items, got %d", len(set))
	}
	for _, key := range []string{"a", "b", "c"} {
		if _, ok := set[key]; !ok {
			t.Fatalf("missing key %q", key)
		}
	}
}
