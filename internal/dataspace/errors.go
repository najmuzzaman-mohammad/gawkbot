package dataspace

import "fmt"

// notFoundError is a ValidationError that also answers errors.Is(err,
// ErrNotFound).
//
// Two contracts meet here and neither can be dropped. types.go says
// ErrNotFound is what a missing type, attribute or record returns, and the
// broker and the MCP tools map that to a 404. The TypeScript mock, which is
// the behaviour oracle, raises a message that names what was missing ("Unknown
// record \"rec_x\".") and its tests assert that wording. So an unknown id
// returns this: errors.As finds the *ValidationError with the message, and
// errors.Is finds ErrNotFound.
type notFoundError struct {
	ValidationError
}

func (e *notFoundError) Unwrap() error { return ErrNotFound }

// As lets errors.As reach the embedded ValidationError, which embedding alone
// does not do: *notFoundError is not assignable to **ValidationError.
func (e *notFoundError) As(target any) bool {
	if into, ok := target.(**ValidationError); ok {
		*into = &e.ValidationError
		return true
	}
	return false
}

// notFound builds the error for an id that names nothing.
func notFound(attribute, format string, args ...any) *notFoundError {
	return &notFoundError{ValidationError{
		Message:   fmt.Sprintf(format, args...),
		Attribute: attribute,
	}}
}
