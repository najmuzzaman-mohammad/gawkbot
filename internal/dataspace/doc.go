// On-disk layout of the SQLite store.
//
// (This is a file comment, not a second package doc: the package doc lives in
// types.go. The blank line below detaches it from the package clause.)
//
// Root, from New(), is <config.RuntimeHomeDir()>/.wuphf/data. Open(root) takes
// any directory, which is what the tests use. Directories are created 0700 and
// every file 0600.
//
//	<root>/spaces.db          the space index
//	<root>/<space_id>.db      one database per space
//	<root>/<space_id>.db-wal  SQLite write-ahead log, same permissions
//	<root>/<space_id>.db-shm
//
// spaces.db holds one row per space and is the source of truth for the space
// record itself: id, owner, name, description, access (JSON), attached app ids
// (JSON), timestamps, and cached object type and record counts. It exists so
// ListSpaces can answer "which spaces may this bot see" without opening a file
// per space, which is the whole point of a flat layout that never moves a file
// when a space is shared or made global. The two counts are the only
// denormalized values; every mutation refreshes them from the space database
// inside the same call, so a crash between the two commits leaves counts stale
// until the next write and nothing else.
//
// <space_id>.db holds the schema and the data:
//
//	meta             schema_version and space_id
//	object_types     one row per type, ordered by position
//	attributes       one row per attribute, ordered by position
//	select_options   one row per option on a select or status attribute
//	relationships    one row per relationship pair
//	records          one row per record
//	record_values    one row per (record, attribute) that holds a value
//	links            one row per link, oriented the way the relationship stores
//	                 it (source side owns the attribute that was created first)
//
// A value lives in record_values.value_json as JSON, so the typed column set
// stays out of the schema and an attribute type can gain a representation
// without a table rewrite. Alongside it, unique_key carries the lowercased,
// trimmed rendering of the value for unique attributes only; a partial UNIQUE
// index over (attribute_id, unique_key) is what actually enforces uniqueness,
// so two concurrent writers cannot both pass a check-then-insert. That race is
// the thing this store exists to get right.
//
// Migrations are keyed on meta.schema_version and run in migrate(); a later
// slice adds a case rather than editing the v1 DDL.

package dataspace
