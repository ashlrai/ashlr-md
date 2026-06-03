// swift-tools-version: 5.9
// Supports macOS 12+ (Monterey) at runtime; macOS 13+ SDK is sufficient to build.
// No macOS 26 / Xcode 26 required — this only uses AppKit, Foundation, and
// UniformTypeIdentifiers, all stable since macOS 12.

import PackageDescription

let package = Package(
    name: "mdopener-setdefault",
    platforms: [
        // Deploy back to macOS 12 so the binary works on any modern Mac.
        // NSWorkspace.setDefaultApplication(at:toOpenContentType:) is 12+.
        .macOS(.v12),
    ],
    targets: [
        .executableTarget(
            name: "mdopener-setdefault",
            path: "Sources/mdopener-setdefault"
        ),
    ]
)
