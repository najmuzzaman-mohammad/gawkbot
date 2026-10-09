import SwiftUI
import UIKit
import GawkbotKit

/// Pick a bot's look: one of the office's eight species (each previewed
/// in the colour being picked) and a body colour from the 12-colour palette
/// or any custom colour. A big live preview at the top squishes when tapped.
/// "Reset to automatic" goes back to the look derived from the bot's slug.
///
/// Save posts `POST /office-members {action:"update", slug, avatar}` through
/// the store and closes on success; a refusal shows inline.
struct AvatarPickerSheet: View {
    let slug: String
    let name: String
    let onSave: (BotAvatar?) async -> String?

    @Environment(\.dismiss) private var dismiss
    @State private var draft: BotAvatar
    @State private var saving = false
    @State private var error: String?

    private let hadOverride: Bool

    init(slug: String, name: String, current: BotAvatar?, onSave: @escaping (BotAvatar?) async -> String?) {
        self.slug = slug
        self.name = name
        self.onSave = onSave
        let start = current ?? BotAvatar()
        self.hadOverride = !start.isAutomatic
        _draft = State(initialValue: start)
    }

    private var look: (shapeIndex: Int, color: String) { BlobAvatar.resolve(slug: slug, avatar: draft) }
    private var colorIsCustom: Bool { draft.colorHex.map { !BlobAvatar.colors.contains($0) } ?? false }

    private let shapeColumns = Array(repeating: GridItem(.flexible(), spacing: 10), count: 4)
    private let colorColumns = Array(repeating: GridItem(.flexible(), spacing: 10), count: 6)

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 22) {
                    preview
                    shapeSection
                    colorSection
                    if let error {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Button(role: .destructive) {
                        save(nil)
                    } label: {
                        Label("Reset to automatic", systemImage: "arrow.counterclockwise")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.large)
                    .disabled(saving || (!hadOverride && draft.isAutomatic))
                    Text(verbatim: "Automatic picks a shape and colour from @\(slug), the same everywhere the office shows it.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .background(Color.softCanvas)
            .navigationTitle("Look")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Save") { save(draft) }
                            .fontWeight(.semibold)
                    }
                }
            }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(saving)
    }

    // MARK: - Sections

    private var preview: some View {
        VStack(spacing: 8) {
            MoodAvatarView(slug: slug, avatar: draft, mood: .idle, size: 120, halo: true)
                .animation(.spring(response: 0.35, dampingFraction: 0.55), value: draft)
            Text(verbatim: name).font(.title3.weight(.semibold))
            Text(draft.isAutomatic ? "Automatic" : "Picked for \(name)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.top, 16)
    }

    private var shapeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("Shape")
            LazyVGrid(columns: shapeColumns, spacing: 10) {
                ForEach(0..<BotAvatar.shapeIDs.count, id: \.self) { index in
                    shapeTile(index)
                }
            }
        }
    }

    private func shapeTile(_ index: Int) -> some View {
        let id = BotAvatar.shapeIDs[index]
        let selected = look.shapeIndex == index
        return Button {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.6)) { draft.shape = id }
            Haptics.lightTap()
        } label: {
            VStack(spacing: 6) {
                BlobAvatarView(slug: slug, avatar: BotAvatar(shape: id, color: look.color), size: 44)
                    .scaleEffect(selected ? 1.08 : 1)
                Text(id.capitalized)
                    .font(.caption2.weight(selected ? .semibold : .regular))
                    .foregroundStyle(selected ? Color.primary : Color.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(Color.softCard, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(selected ? Color.accentColor : Color.softHairline, lineWidth: selected ? 2 : 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(id.capitalized) shape")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var colorSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("Colour")
            LazyVGrid(columns: colorColumns, spacing: 12) {
                ForEach(BlobAvatar.colors, id: \.self) { hex in
                    colorSwatch(hex)
                }
            }
            HStack(spacing: 12) {
                ColorPicker(selection: customColor, supportsOpacity: false) {
                    Label("Custom colour", systemImage: "eyedropper")
                }
                if colorIsCustom {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Color.accentColor)
                        .accessibilityLabel("Custom colour picked")
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color.softCard, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }

    private func colorSwatch(_ hex: String) -> some View {
        let selected = look.color == hex
        return Button {
            withAnimation(.easeInOut(duration: 0.2)) { draft.color = hex }
            Haptics.lightTap()
        } label: {
            Circle()
                .fill(Color(hex: hex))
                .frame(width: 34, height: 34)
                .padding(4)
                .overlay(
                    Circle().strokeBorder(selected ? Color.primary : Color.clear, lineWidth: 2)
                )
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Colour \(hex)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Colour picker bridge

    /// The ColorPicker shows the colour being drawn and writes a custom pick
    /// back as `#rrggbb` (clamped to sRGB, opacity ignored).
    private var customColor: Binding<Color> {
        Binding(
            get: { Color(hex: look.color) },
            set: { draft.color = AvatarPickerSheet.hex(of: $0) }
        )
    }

    static func hex(of color: Color) -> String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        _ = UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a)
        return BotAvatar.hex(red: Double(r), green: Double(g), blue: Double(b))
    }

    // MARK: - Save

    private func save(_ avatar: BotAvatar?) {
        saving = true
        error = nil
        Task { @MainActor in
            let refusal = await onSave(avatar)
            saving = false
            if let refusal {
                error = refusal
            } else {
                dismiss()
            }
        }
    }
}
