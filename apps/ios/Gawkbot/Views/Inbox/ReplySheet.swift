import SwiftUI
import GawkbotKit

/// What a reply answers: a question, optionally through one of its
/// write-in options ("Reject with steer", "Someone else").
struct ReplyTarget: Identifiable {
    let attention: NotchAttention
    let option: InterviewOption?
    var id: String { attention.id + "/" + (option?.id ?? "") }
}

/// Answer a question in your own words. With an option, the text goes with
/// that option; without one, it is the whole answer (`custom_text`).
struct ReplySheet: View {
    let target: ReplyTarget
    let onSend: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @FocusState private var focused: Bool

    private var canSend: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 10) {
                    BlobAvatarView(slug: target.attention.from, size: 32)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(target.attention.displayName).font(.subheadline.weight(.semibold))
                        if let option = target.option {
                            Text(option.label).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                Text(verbatim: target.attention.title.flatMap { $0.isEmpty ? nil : $0 } ?? target.attention.question)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(4)
                TextField("Your answer", text: $text, axis: .vertical)
                    .lineLimit(3...8)
                    .focused($focused)
                    .padding(12)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                Text("Sent to the office as your answer. Anything it leads to still goes through the office's approvals.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .padding()
            .navigationTitle("Reply")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") {
                        onSend(text.trimmingCharacters(in: .whitespacesAndNewlines))
                        dismiss()
                    }
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!canSend)
                }
            }
            .onAppear { focused = true }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(.regularMaterial)
    }
}
