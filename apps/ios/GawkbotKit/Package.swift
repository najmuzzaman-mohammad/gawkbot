// swift-tools-version:5.9
import PackageDescription

// GawkbotKit is the UIKit-free half of the iOS app: wire models, the broker
// client (REST + the /events stream), a mock broker for previews and
// screenshots, pairing, and the blob-avatar port. It has no UI so it tests on
// the macOS host with `swift test` and needs no simulator.
let package = Package(
    name: "GawkbotKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "GawkbotKit", targets: ["GawkbotKit"]),
    ],
    targets: [
        .target(name: "GawkbotKit"),
        .testTarget(name: "GawkbotKitTests", dependencies: ["GawkbotKit"]),
    ]
)
