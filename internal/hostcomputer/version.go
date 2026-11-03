package hostcomputer

// The driver release bundled with the desktop app. The host pin is separate
// from the container image's (internal/computer/image.go): embedded mode,
// per-session agent cursors and batched steps arrived after the version the
// container runs. Bump both constants together; the fetch script verifies
// the archive against the checksum before it goes into the bundle.
const (
	// DriverVersion is the cua-driver-rs release number.
	DriverVersion = "0.35.4"
	// DriverReleaseTag is the GitHub release the archive is downloaded from.
	DriverReleaseTag = "cua-driver-rs-v" + DriverVersion
	// DriverDarwinUniversalAsset is the macOS archive holding the universal
	// binary (and its SDK dylib, which the app does not ship).
	DriverDarwinUniversalAsset = "cua-driver-rs-" + DriverVersion + "-darwin-universal-binary.tar.gz"
	// DriverDarwinUniversalSHA256 is that archive's published checksum.
	DriverDarwinUniversalSHA256 = "496d8c689e880f2afa484dc322ba71b59d6ec9ada25ffef9d9f51a31ad74cbf5"
	// HelperName is the binary's name inside the app bundle's Helpers.
	HelperName = "cua-driver"
)
