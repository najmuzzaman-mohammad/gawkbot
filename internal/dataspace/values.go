package dataspace

import (
	"math"
	"net/url"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// MaxOptionsInError caps how many option names a rejection lists, so an
// attribute with hundreds of options still produces a readable message.
const MaxOptionsInError = 25

var (
	dateOnlyPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	rfc3339Pattern  = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$`)
	emailPattern    = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)
)

// dateLayout is the only shape a date value is ever stored in.
const dateLayout = "2006-01-02"

// isBlank reports whether raw means "empty": nil, or a string of whitespace.
func isBlank(raw any) bool {
	if raw == nil {
		return true
	}
	if s, ok := raw.(string); ok {
		return strings.TrimSpace(s) == ""
	}
	return false
}

// isList reports whether raw is a list the caller passed for a multivalue
// attribute. A []byte is not a list here; nothing stores raw bytes.
func isList(raw any) bool {
	if raw == nil {
		return false
	}
	if _, ok := raw.([]byte); ok {
		return false
	}
	kind := reflect.TypeOf(raw).Kind()
	return kind == reflect.Slice || kind == reflect.Array
}

func listItems(raw any) []any {
	value := reflect.ValueOf(raw)
	items := make([]any, 0, value.Len())
	for i := 0; i < value.Len(); i++ {
		items = append(items, value.Index(i).Interface())
	}
	return items
}

func coerceNumber(attr *Attribute, raw any) (float64, error) {
	if f, ok := asFloat(raw); ok && !math.IsNaN(f) && !math.IsInf(f, 0) {
		return f, nil
	}
	if s, ok := raw.(string); ok && strings.TrimSpace(s) != "" {
		parsed, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
		if err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0) {
			return parsed, nil
		}
	}
	return 0, Invalid(attr.Slug, "%s must be a number; got %s.", attr.Name, show(raw))
}

func coerceRating(attr *Attribute, raw any) (float64, error) {
	value, err := coerceNumber(attr, raw)
	if err != nil {
		return 0, err
	}
	if value != math.Trunc(value) || value < 1 || value > 5 {
		return 0, Invalid(attr.Slug,
			"%s must be a whole number from 1 to 5; got %s.", attr.Name, show(raw))
	}
	return value, nil
}

func coerceDate(attr *Attribute, raw any) (string, error) {
	if s, ok := raw.(string); ok {
		trimmed := strings.TrimSpace(s)
		// The calendar date is kept exactly as written; no time zone shift.
		datePart := trimmed
		if match := rfc3339Pattern.FindStringSubmatch(trimmed); match != nil {
			datePart = match[1]
		}
		if isRealDate(datePart) {
			return datePart, nil
		}
	}
	return "", Invalid(attr.Slug,
		"%s must be a date as YYYY-MM-DD or RFC3339; got %s.", attr.Name, show(raw))
}

func isRealDate(value string) bool {
	if !dateOnlyPattern.MatchString(value) {
		return false
	}
	parsed, err := time.Parse(dateLayout, value)
	if err != nil {
		return false
	}
	return parsed.Format(dateLayout) == value
}

func coerceToggle(attr *Attribute, raw any) (bool, error) {
	if b, ok := raw.(bool); ok {
		return b, nil
	}
	if s, ok := raw.(string); ok {
		switch strings.ToLower(strings.TrimSpace(s)) {
		case "true":
			return true, nil
		case "false":
			return false, nil
		}
	}
	return false, Invalid(attr.Slug, "%s must be true or false; got %s.", attr.Name, show(raw))
}

func coerceString(attr *Attribute, raw any) (string, error) {
	s, ok := raw.(string)
	if !ok {
		return "", Invalid(attr.Slug, "%s must be text; got %s.", attr.Name, show(raw))
	}
	if attr.Type == TypeText {
		return s, nil
	}
	return strings.TrimSpace(s), nil
}

func coerceEmail(attr *Attribute, raw any) (string, error) {
	value, err := coerceString(attr, raw)
	if err != nil {
		return "", err
	}
	if !emailPattern.MatchString(value) {
		return "", Invalid(attr.Slug,
			"%s must be an email address like name@company.com; got %s.", attr.Name, show(raw))
	}
	return value, nil
}

func coerceURL(attr *Attribute, raw any) (string, error) {
	value, err := coerceString(attr, raw)
	if err != nil {
		return "", err
	}
	parsed, parseErr := url.Parse(value)
	if parseErr != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", Invalid(attr.Slug,
			"%s must be a full URL starting with http:// or https://; got %s.", attr.Name, show(raw))
	}
	return value, nil
}

// coerceOption matches by option id first, then by case-insensitive trimmed
// name, and otherwise lists what would have worked.
func coerceOption(attr *Attribute, raw any) (string, error) {
	wanted := valueString(raw)
	if s, ok := raw.(string); ok {
		wanted = strings.TrimSpace(s)
	}
	for _, option := range attr.Options {
		if option.ID == wanted {
			return option.ID, nil
		}
	}
	for _, option := range attr.Options {
		if strings.EqualFold(strings.TrimSpace(option.Name), wanted) {
			return option.ID, nil
		}
	}
	names := make([]string, 0, len(attr.Options))
	for _, option := range attr.Options {
		names = append(names, option.Name)
	}
	shown := names
	more := ""
	if len(names) > MaxOptionsInError {
		shown = names[:MaxOptionsInError]
		more = ", and " + strconv.Itoa(len(names)-MaxOptionsInError) + " more"
	}
	return "", Invalid(attr.Slug, "%q is not a valid option for %s. Valid options: %s%s.",
		wanted, attr.Name, strings.Join(shown, ", "), more)
}

func coerceScalar(attr *Attribute, raw any) (Value, error) {
	switch attr.Type {
	case TypeNumber, TypeCurrency:
		return coerceNumber(attr, raw)
	case TypeRating:
		return coerceRating(attr, raw)
	case TypeDate:
		return coerceDate(attr, raw)
	case TypeToggle:
		return coerceToggle(attr, raw)
	case TypeEmail:
		return coerceEmail(attr, raw)
	case TypeURL:
		return coerceURL(attr, raw)
	case TypeSelect, TypeStatus:
		return coerceOption(attr, raw)
	case TypeRelationship:
		// The wording names the action, not the tool: the same sentence is read
		// by a bot (whose tool is data_link_records) and by the operator in the
		// web UI, and neither can act on a Go method name.
		return nil, Invalid(attr.Slug,
			"%q is a relationship, so it is set by linking records, not by setting a value.",
			attr.Slug)
	case TypeText, TypePhone:
		return coerceString(attr, raw)
	default:
		return coerceString(attr, raw)
	}
}

// coerceMany takes a list or a bare scalar and returns a de-duplicated list,
// or nil when nothing is left.
func coerceMany(attr *Attribute, raw any) (Value, error) {
	items := []any{raw}
	if isList(raw) {
		items = listItems(raw)
	}
	seen := map[string]bool{}
	out := []string{}
	for _, item := range items {
		if isBlank(item) {
			continue
		}
		value, err := coerceScalar(attr, item)
		if err != nil {
			return nil, err
		}
		text := valueString(value)
		key := text
		if attr.Type == TypeEmail {
			key = strings.ToLower(text)
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, text)
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

// coerceValue returns the value to store, or nil when the input means "empty".
func coerceValue(attr *Attribute, raw any) (Value, error) {
	if attr.IsMultivalue {
		return coerceMany(attr, raw)
	}
	if isList(raw) {
		return nil, Invalid(attr.Slug, "%s holds a single value, not a list.", attr.Name)
	}
	if isBlank(raw) {
		return nil, nil
	}
	return coerceScalar(attr, raw)
}
