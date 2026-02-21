package main

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"

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

func TestProgressiveDiscordSender_UsesFirstThenNext(t *testing.T) {
	var first []string
	var next []string
	sender := &progressiveDiscordSender{
		sendFirst: func(content string) error {
			first = append(first, content)
			return nil
		},
		sendNext: func(content string) error {
			next = append(next, content)
			return nil
		},
	}

	if err := sender.SendPart("part one"); err != nil {
		t.Fatalf("SendPart part one: %v", err)
	}
	if err := sender.SendPart("part two"); err != nil {
		t.Fatalf("SendPart part two: %v", err)
	}
	if len(first) != 1 || first[0] != "part one" {
		t.Fatalf("unexpected first sends: %#v", first)
	}
	if len(next) != 1 || next[0] != "part two" {
		t.Fatalf("unexpected next sends: %#v", next)
	}
}

func TestProgressiveDiscordSender_SplitsLongPart(t *testing.T) {
	var sends []string
	sender := &progressiveDiscordSender{
		sendFirst: func(content string) error {
			sends = append(sends, content)
			return nil
		},
		sendNext: func(content string) error {
			sends = append(sends, content)
			return nil
		},
	}

	long := strings.Repeat("a", discordMessageLimit+250)
	if err := sender.SendPart(long); err != nil {
		t.Fatalf("SendPart long: %v", err)
	}
	if len(sends) < 2 {
		t.Fatalf("expected split sends, got %d", len(sends))
	}
	for i, send := range sends {
		if len(send) > discordMessageLimit {
			t.Fatalf("send %d exceeds limit: %d", i, len(send))
		}
	}
}

func TestStartTypingHeartbeat_EmitsUntilStopped(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var sends int32
	stop := startTypingHeartbeat(ctx, 10*time.Millisecond, func() {
		atomic.AddInt32(&sends, 1)
	})
	time.Sleep(35 * time.Millisecond)
	stop()
	gotBefore := atomic.LoadInt32(&sends)
	if gotBefore < 2 {
		t.Fatalf("expected at least 2 heartbeat sends, got %d", gotBefore)
	}

	time.Sleep(20 * time.Millisecond)
	gotAfter := atomic.LoadInt32(&sends)
	if gotAfter != gotBefore {
		t.Fatalf("expected heartbeat to stop; before=%d after=%d", gotBefore, gotAfter)
	}
}
