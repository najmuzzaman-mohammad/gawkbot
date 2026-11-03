package team

// broker_notch_read.go: what the owner has read of each bot's thread, so a
// row in the notch can show the last line and a dot for what is new. The
// thread marks the newest line read each time it shows (POST /notch/read
// {channel, message_id}); the marks are saved to notch-read.json beside the
// broker state, with their own lock, like the other notch stores. A line
// is unread when it came after the mark and is not the owner's own.

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

const notchReadMax = 256

type notchReadStore struct {
	mu     sync.Mutex
	loaded bool
	// marks maps a channel to the id of the last message read there.
	marks map[string]string
}

func (b *Broker) notchReadPath() string {
	return filepath.Join(filepath.Dir(b.statePath), "notch-read.json")
}

func (s *notchReadStore) loadLocked(path string) {
	if s.loaded {
		return
	}
	s.loaded = true
	s.marks = map[string]string{}
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var saved map[string]string
	if json.Unmarshal(raw, &saved) != nil {
		return
	}
	for ch, id := range saved {
		if strings.TrimSpace(ch) != "" && strings.TrimSpace(id) != "" {
			s.marks[ch] = id
		}
	}
}

// notchReadMarks returns a copy of the marks.
func (b *Broker) notchReadMarks() map[string]string {
	s := &b.notchRead
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadLocked(b.notchReadPath())
	out := make(map[string]string, len(s.marks))
	for ch, id := range s.marks {
		out[ch] = id
	}
	return out
}

// markNotchRead records messageID as read in channel. Marks only move
// forward: an older poll cannot unread a newer line.
func (b *Broker) markNotchRead(channel, messageID string) error {
	s := &b.notchRead
	s.mu.Lock()
	defer s.mu.Unlock()
	path := b.notchReadPath()
	s.loadLocked(path)
	if old, ok := s.marks[channel]; ok && messageSeq(old) >= messageSeq(messageID) {
		return nil
	}
	if len(s.marks) >= notchReadMax {
		// Drop the lowest marks: they name conversations long quiet.
		lowest, lowestSeq := "", int64(-1)
		for ch, id := range s.marks {
			if seq := messageSeq(id); lowest == "" || seq < lowestSeq {
				lowest, lowestSeq = ch, seq
			}
		}
		delete(s.marks, lowest)
	}
	s.marks[channel] = messageID
	raw, err := json.Marshal(s.marks)
	if err != nil {
		return err
	}
	return atomicWriteFile(path, raw)
}

// messageSeq is the number in a message id ("msg-42" → 42); ids are minted
// in order, so a larger number is a later message. -1 for anything else.
func messageSeq(id string) int64 {
	n, err := strconv.ParseInt(strings.TrimPrefix(strings.TrimSpace(id), "msg-"), 10, 64)
	if err != nil {
		return -1
	}
	return n
}

// notchUnreadLocked counts the lines in room after the read mark that are
// not the owner's own. Caller holds b.mu.
func (b *Broker) notchUnreadLocked(room, mark string) int {
	if room == "" {
		return 0
	}
	after := messageSeq(mark)
	n := 0
	for i := len(b.messages) - 1; i >= 0; i-- {
		msg := b.messages[i]
		if msg.Channel != room {
			continue
		}
		if messageSeq(msg.ID) <= after {
			break
		}
		if msg.From == "human" || msg.From == "you" || msg.From == "system" || strings.TrimSpace(msg.Content) == "" {
			continue
		}
		n++
	}
	return n
}

type notchReadRequest struct {
	Channel   string `json:"channel"`
	MessageID string `json:"message_id"`
}

// handleNotchRead is POST /notch/read. Owner only.
func (b *Broker) handleNotchRead(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !b.requestHasBrokerAuth(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only the owner reads in the notch"})
		return
	}
	var req notchReadRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	channel := normalizeChannelSlug(req.Channel)
	if channel == "" || messageSeq(req.MessageID) < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "which message?"})
		return
	}
	if err := b.markNotchRead(channel, strings.TrimSpace(req.MessageID)); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not save"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
