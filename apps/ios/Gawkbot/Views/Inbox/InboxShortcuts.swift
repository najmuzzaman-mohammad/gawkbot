import SwiftUI
import GawkbotKit

extension InboxKey {
    var keyEquivalent: KeyEquivalent {
        switch self {
        case let .character(c): return KeyEquivalent(c)
        case .upArrow: return .upArrow
        case .downArrow: return .downArrow
        case .returnKey: return .return
        case .escape: return .escape
        }
    }
}

/// The inbox's hardware-keyboard shortcuts: one invisible button per
/// binding in `InboxKeymap` (the mapping lives in GawkbotKit and is unit
/// tested). Bare keys only, so ⌘V and every other system shortcut pass
/// through. Disabled while a text field or the voice confirmation owns the
/// keyboard, so typing "j" in a reply never moves the selection.
struct InboxShortcuts: View {
    let enabled: Bool
    let perform: (InboxCommand) -> Void

    var body: some View {
        ZStack {
            ForEach(InboxKeymap.bindings) { binding in
                Button(binding.title) { perform(binding.command) }
                    .keyboardShortcut(binding.key.keyEquivalent, modifiers: [])
            }
        }
        .disabled(!enabled)
        // TODO(compile): zero-opacity buttons keep their shortcuts on iOS in
        // practice; verify on a device with a keyboard. If they do not fire,
        // move these into `.toolbar` items or use `.onKeyPress` (iOS 17).
        .frame(width: 0, height: 0)
        .opacity(0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
