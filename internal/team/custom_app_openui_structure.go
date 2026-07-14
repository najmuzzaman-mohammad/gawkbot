package team

import (
	"fmt"
	"regexp"
	"strings"
)

var customAppOpenUIAssignmentRE = regexp.MustCompile(`^([A-Za-z_$][A-Za-z0-9_]*)\s*=\s*(.*)$`)

// validateCustomAppOpenUIStructure is the in-process persistence preflight for
// syntax failures the policy regexes cannot see. The authoritative component
// schema parser is JavaScript-only, so the browser still repeats full parsing;
// this scanner makes incomplete documents fail closed before Save writes them.
func validateCustomAppOpenUIStructure(source string) error {
	if strings.Contains(source, "```") {
		return newCustomAppCallerError("app: openui must not contain markdown fences")
	}
	stack := make([]rune, 0, 16)
	seen := map[string]bool{}
	rootSeen := false

	for lineNumber, rawLine := range strings.Split(source, "\n") {
		code, err := customAppOpenUICodeLine(rawLine)
		if err != nil {
			return newCustomAppCallerError("app: openui line %d: %v", lineNumber+1, err)
		}
		trimmed := strings.TrimSpace(code)
		if len(stack) == 0 && trimmed != "" {
			match := customAppOpenUIAssignmentRE.FindStringSubmatch(trimmed)
			if match == nil {
				return newCustomAppCallerError("app: openui line %d must begin with an assignment", lineNumber+1)
			}
			name := match[1]
			if seen[name] {
				return newCustomAppCallerError("app: openui statement %q is defined more than once", name)
			}
			seen[name] = true
			if name == "root" {
				if !strings.HasPrefix(strings.TrimSpace(match[2]), "App(") {
					return newCustomAppCallerError("app: openui root must use App(...)")
				}
				rootSeen = true
			}
		}
		if err := updateCustomAppOpenUIDelimiters(code, &stack); err != nil {
			return newCustomAppCallerError("app: openui line %d: %v", lineNumber+1, err)
		}
	}
	if len(stack) != 0 {
		return newCustomAppCallerError("app: openui has an unclosed %q delimiter", string(stack[len(stack)-1]))
	}
	if !rootSeen {
		return newCustomAppCallerError("app: openui must define root = App(...)")
	}
	return nil
}

// customAppOpenUICodeLine removes comments outside strings and validates
// string termination. OpenUI strings are single-line; escapes preserve the
// following byte verbatim for this structural pass.
func customAppOpenUICodeLine(line string) (string, error) {
	var out strings.Builder
	var quote rune
	escaped := false
	runes := []rune(line)
	for i, ch := range runes {
		if quote != 0 {
			out.WriteRune(ch)
			if escaped {
				escaped = false
				continue
			}
			if ch == '\\' {
				escaped = true
				continue
			}
			if ch == quote {
				quote = 0
			}
			continue
		}
		if ch == '"' || ch == '\'' {
			quote = ch
			out.WriteRune(ch)
			continue
		}
		if ch == '#' || (ch == '/' && i+1 < len(runes) && runes[i+1] == '/') {
			break
		}
		out.WriteRune(ch)
	}
	if escaped {
		return "", fmt.Errorf("string ends with a dangling escape")
	}
	if quote != 0 {
		return "", fmt.Errorf("unterminated string")
	}
	return out.String(), nil
}

func updateCustomAppOpenUIDelimiters(code string, stack *[]rune) error {
	var quote rune
	escaped := false
	for _, ch := range code {
		if quote != 0 {
			if escaped {
				escaped = false
				continue
			}
			if ch == '\\' {
				escaped = true
				continue
			}
			if ch == quote {
				quote = 0
			}
			continue
		}
		if ch == '"' || ch == '\'' {
			quote = ch
			continue
		}
		switch ch {
		case '(', '[', '{':
			*stack = append(*stack, ch)
		case ')', ']', '}':
			if len(*stack) == 0 {
				return fmt.Errorf("unexpected closing delimiter %q", string(ch))
			}
			open := (*stack)[len(*stack)-1]
			if !customAppOpenUIDelimitersMatch(open, ch) {
				return fmt.Errorf("closing delimiter %q does not match %q", string(ch), string(open))
			}
			*stack = (*stack)[:len(*stack)-1]
		}
	}
	return nil
}

func customAppOpenUIDelimitersMatch(open, close rune) bool {
	return open == '(' && close == ')' || open == '[' && close == ']' || open == '{' && close == '}'
}
