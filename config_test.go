package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExpandTildeReplacesPrefix(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("cannot determine home directory")
	}
	got := expandTilde("~/foo/bar")
	want := filepath.Join(home, "foo/bar")
	if got != want {
		t.Fatalf("expandTilde(\"~/foo/bar\") = %q, want %q", got, want)
	}
}

func TestExpandTildeNoopForAbsolutePath(t *testing.T) {
	got := expandTilde("/etc/config")
	if got != "/etc/config" {
		t.Fatalf("expandTilde(\"/etc/config\") = %q, want \"/etc/config\"", got)
	}
}

func TestExpandTildeNoopForRelativePath(t *testing.T) {
	got := expandTilde("relative/path")
	if got != "relative/path" {
		t.Fatalf("expandTilde(\"relative/path\") = %q, want \"relative/path\"", got)
	}
}

func TestExpandTildeNoopForEmpty(t *testing.T) {
	got := expandTilde("")
	if got != "" {
		t.Fatalf("expandTilde(\"\") = %q, want \"\"", got)
	}
}

func TestExpandTildeNoopForBareHome(t *testing.T) {
	// "~" alone (without trailing slash) should not be expanded.
	got := expandTilde("~")
	if got != "~" {
		t.Fatalf("expandTilde(\"~\") = %q, want \"~\"", got)
	}
}
