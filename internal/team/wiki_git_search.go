package team

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// searchArticles walks team/ and returns every line that contains the literal
// pattern. This is intentionally not a regex — bots never get to inject
// patterns that could DoS the search. Limit 100 hits per query.
func searchArticles(repo *Repo, pattern string) ([]WikiSearchHit, error) {
	pattern = strings.TrimSpace(pattern)
	if pattern == "" {
		return nil, fmt.Errorf("wiki: search pattern is required")
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()

	teamDir := filepath.Join(repo.root, "team")
	if _, err := os.Stat(teamDir); err != nil {
		return nil, nil
	}
	const maxHits = 100
	hits := make([]WikiSearchHit, 0, 16)
	err := filepath.Walk(teamDir, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info.IsDir() {
			return nil
		}
		if !strings.HasSuffix(strings.ToLower(path), ".md") {
			return nil
		}
		if len(hits) >= maxHits {
			return filepath.SkipDir
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil //nolint:nilerr // non-fatal: skip unreadable file (race with delete)
		}
		// Skip archived tombstones — they are no longer active wiki content.
		if parseFrontmatterBool(string(data), "archived") {
			return nil
		}
		rel, _ := filepath.Rel(repo.root, path)
		rel = filepath.ToSlash(rel)
		scanner := bufio.NewScanner(strings.NewReader(string(data)))
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		lineNo := 0
		for scanner.Scan() {
			lineNo++
			line := scanner.Text()
			if strings.Contains(line, pattern) {
				hits = append(hits, WikiSearchHit{
					Path:    rel,
					Line:    lineNo,
					Snippet: strings.TrimSpace(line),
				})
				if len(hits) >= maxHits {
					return filepath.SkipDir
				}
			}
		}
		if err := scanner.Err(); err != nil {
			return fmt.Errorf("scan %s: %w", path, err)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("wiki: search walk: %w", err)
	}
	return hits, nil
}
