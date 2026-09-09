import SwiftUI
import GawkbotKit

/// A bot's ask, rendered as a card in the thread with its options as
/// buttons. Options that need text open a small sheet.
struct RequestCardView: View {
    let request: BotRequest
    let botName: String
    let onAnswer: (InterviewOption, String?) -> Void

    @State private var textFor: InterviewOption?
    @State private var note = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "questionmark.circle.fill").foregroundStyle(.orange)
                Text("\(botName) asks").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                Text((request.kind ?? "request").uppercased()).font(.caption2.weight(.bold)).foregroundStyle(.secondary)
            }
            if let title = request.title, !title.isEmpty {
                Text(title).font(.headline)
            }
            Text(request.question).font(.body)
            VStack(spacing: 8) {
                ForEach(request.buttons) { option in
                    Button {
                        if option.requiresText == true {
                            textFor = option
                        } else {
                            #if os(iOS)
                            UINotificationFeedbackGenerator().notificationOccurred(.success)
                            #endif
                            onAnswer(option, nil)
                        }
                    } label: {
                        Text(option.label).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(tint(for: option))
                    .controlSize(.regular)
                }
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color(.secondarySystemBackground)))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Color.orange.opacity(0.35), lineWidth: 1))
        .sheet(item: $textFor) { option in
            NavigationStack {
                Form {
                    Section(option.label) {
                        TextField("Add a note", text: $note, axis: .vertical).lineLimit(3...8)
                    }
                }
                .navigationTitle(botName)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { textFor = nil } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Send") {
                            onAnswer(option, note)
                            note = ""
                            textFor = nil
                        }
                        .disabled(note.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .presentationDetents([.medium])
        }
    }

    private func tint(for option: InterviewOption) -> Color {
        let id = option.id.lowercased()
        if id.hasPrefix("approve") || id == request.recommendedID { return .accentColor }
        if id.hasPrefix("reject") { return .red }
        return .secondary
    }
}
