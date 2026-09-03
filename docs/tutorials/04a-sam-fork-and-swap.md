# 04a — Sam forks a bot + swaps in a research role (Scenario 4: configure)

## Who and why

**Persona:** Sam Rivera, CTO at an eight-person startup. They have run
WUPHF for a day. They are now testing the architectural-fit claim:
bot configs are plain JSON, the system is forkable, and a research
bot can replace the default ENG without changing the framework.

**Outcome they came for:** edit one JSON file, restart wuphf, and see
the new "Research" bot appear in the participants column with the
behavior described in its system prompt.

## Steps

### 1. Locate the bot configs

```bash
ls ~/.wuphf/agents/
```

#### Verify

- The directory contains one JSON file per bot (`ceo.json`,
  `eng.json`, `dsg.json`, `cmo.json`).
- Each file has `name`, `slug`, `system_prompt`, and `tools` keys.

### 2. Copy `eng.json` into a new `research.json`

```bash
cp ~/.wuphf/agents/eng.json ~/.wuphf/agents/research.json
```

Edit `research.json`:

- Change `name` to `"Research"`.
- Change `slug` to `"research"`.
- Replace `system_prompt` with a research-bot prompt (e.g.
  "You are a research bot. When asked for a take, cite the source
  paper or doc you used.").

### 3. Remove `eng.json`

```bash
rm ~/.wuphf/agents/eng.json
```

#### Verify

- `~/.wuphf/agents/` now lists CEO, DSG, CMO, Research.

### 4. Restart wuphf

In the running CLI, Ctrl+C, then `npx wuphf` again.

#### Verify

- The participants column on `#general` shows the new Research bot
  instead of ENG.
- Hovering Research shows the system prompt content.

### 5. Drop a research goal

In `#general`:

```
Find the best practices doc for OAuth PKCE flows in 2024. Cite the
source. CEO can decide whether we adopt section 4.
```

#### Verify

- Research replies with at least one inline citation (URL or
  doc title).
- CEO follows up with a decision-style packet.

## What success looks like

A clean edit to a JSON file replaces a bot role and shows up
immediately on restart. No code change, no plugin install, no
framework re-init — the same observation the Paperclip ICP
asked about ("forkable architecture, JSON configs, no cloud
dependency").
