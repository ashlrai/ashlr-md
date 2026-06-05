// mdopener-setdefault — set Ashlr MD as the default handler for Markdown files.
//
// Usage:
//   mdopener-setdefault check  <app-bundle-url>
//   mdopener-setdefault set    <app-bundle-url>
//   mdopener-setdefault help
//
// Exit codes:
//   0 — success (or "check" result printed to stdout as JSON)
//   1 — error (message on stderr)
//
// "check" output (one JSON line to stdout):
//   {"isDefault":true}   or   {"isDefault":false}
//
// The binary intentionally has no dependency on any 3rd-party library so it
// links against Foundation, AppKit, and UniformTypeIdentifiers only — all
// system frameworks available on macOS 12+.
//
// This binary is spawned by default_handler.rs for every check/set call; it
// is NOT a long-lived process.

import Foundation
import AppKit
import UniformTypeIdentifiers

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func jsonLine(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       let s = String(data: data, encoding: .utf8) {
        print(s)
        fflush(stdout)
    }
}

func fail(_ message: String) -> Never {
    fputs("mdopener-setdefault: \(message)\n", stderr)
    exit(1)
}

// ---------------------------------------------------------------------------
// Markdown UTTypes
// The extensions we want to claim — mirrors tauri.conf.json fileAssociations.
// ---------------------------------------------------------------------------

// All extension strings we want to own. We iterate over each because
// `setDefaultApplication` takes a single content type per call.
let mdExtensions = ["md", "markdown", "mdown", "mkd", "mdx"]

// ---------------------------------------------------------------------------
// Check: is this app bundle currently the default for .md?
// ---------------------------------------------------------------------------

@available(macOS 12.0, *)
func checkIsDefault(bundleURL: URL) -> Bool {
    // We only need to check the primary "md" extension — if this app is the
    // default for .md it is almost certainly the default for all of them.
    guard let utType = UTType(filenameExtension: "md") else {
        return false
    }
    let ws = NSWorkspace.shared
    // The macOS 26 SDK renamed the parameter label `toOpenContentType:` → `toOpen:`.
    // Compile against whichever label the build SDK exposes so this helper builds
    // on Xcode 15/16 (GitHub runners today) AND Xcode 26 — both run on macOS 12+.
    #if compiler(>=6.2)
    let currentDefault = ws.urlForApplication(toOpen: utType)
    #else
    let currentDefault = ws.urlForApplication(toOpenContentType: utType)
    #endif
    // Normalise both URLs by resolving symlinks so /private/var and /var compare equal.
    let a = bundleURL.resolvingSymlinksInPath().standardizedFileURL
    let b = currentDefault?.resolvingSymlinksInPath().standardizedFileURL
    return a == b
}

// ---------------------------------------------------------------------------
// Set: register this app as the default for all Markdown extensions.
// Uses NSWorkspace.setDefaultApplication(at:toOpenContentType:completionHandler:)
// which is available from macOS 12 (Monterey) onwards.
// ---------------------------------------------------------------------------

@available(macOS 12.0, *)
func setAsDefault(bundleURL: URL) {
    let ws = NSWorkspace.shared

    // The macOS 26 SDK exposes only the async/throws variant of
    // setDefaultApplication(at:toOpenContentType:), so we drive each call from a
    // Task and block on a semaphore (short-lived CLI; ordering doesn't matter).
    // A reference box lets the Task report its error back without a lock —
    // the semaphore already serializes each call, so there's no contention.
    final class ErrBox { var message: String? }
    var errors: [String] = []

    for ext in mdExtensions {
        guard let utType = UTType(filenameExtension: ext) else {
            // Extension produced no UTType on this system — skip silently.
            continue
        }

        let box = ErrBox()
        let sema = DispatchSemaphore(value: 0)
        // macOS 26 SDK exposes the async/throws `setDefaultApplication(at:toOpen:)`;
        // older SDKs expose the completion-handler `setDefaultApplication(at:toOpenContentType:)`.
        // Pick the right one at compile time so the helper builds on any Xcode.
        #if compiler(>=6.2)
        Task {
            do {
                try await ws.setDefaultApplication(at: bundleURL, toOpen: utType)
            } catch {
                box.message = error.localizedDescription
            }
            sema.signal()
        }
        #else
        ws.setDefaultApplication(at: bundleURL, toOpenContentType: utType) { error in
            box.message = error?.localizedDescription
            sema.signal()
        }
        #endif
        sema.wait()
        if let message = box.message {
            errors.append("\(ext): \(message)")
        }
    }

    if errors.isEmpty {
        jsonLine(["ok": true])
    } else {
        // Surface the first error to Rust; partial success is still likely fine
        // (the primary "md" extension is what matters most).
        fputs("mdopener-setdefault errors: \(errors.joined(separator: "; "))\n", stderr)
        // Exit 0 with a warning so Rust can surface it as a soft error rather
        // than treating the whole operation as failed.
        jsonLine(["ok": true, "warnings": errors])
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

let args = CommandLine.arguments

guard args.count >= 3 else {
    // Print usage to stderr; Rust checks exit code not this message.
    fputs("Usage: mdopener-setdefault <check|set|help> <app-bundle-url>\n", stderr)
    exit(1)
}

let command = args[1]
let rawURL = args[2]

// The app bundle URL must be a valid file URL.
guard let bundleURL = URL(string: rawURL) ?? URL(string: "file://\(rawURL)") else {
    fail("invalid bundle URL: \(rawURL)")
}

// Ensure we have a real file URL.
let fileURL: URL
if bundleURL.isFileURL {
    fileURL = bundleURL
} else {
    fileURL = URL(fileURLWithPath: rawURL)
}

// Require macOS 12 for NSWorkspace.setDefaultApplication.
// On older systems we exit 0 with a JSON error so Rust can show a graceful message.
guard #available(macOS 12.0, *) else {
    jsonLine([
        "ok": false,
        "error": "Setting a default app programmatically requires macOS 12 or later."
    ])
    exit(0)
}

switch command {
case "check":
    let isDefault = checkIsDefault(bundleURL: fileURL)
    jsonLine(["isDefault": isDefault])

case "set":
    setAsDefault(bundleURL: fileURL)

case "help":
    print("mdopener-setdefault: set Ashlr MD as the default Markdown handler.")
    print("Commands: check <url>, set <url>")

default:
    fail("unknown command '\(command)'. Expected: check, set, help")
}
