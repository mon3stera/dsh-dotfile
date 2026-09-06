# Computer Use (dsh-plugin-computer-use)

Five agent tools that let a session see and operate the niri/Wayland desktop the
DSH process runs in. Host-side only — no browser half.

## Tools

| Tool | Reads/writes | Backend |
|---|---|---|
| `desktop_windows` | window list, focus, close, fullscreen | `niri msg --json` IPC |
| `desktop_tree` | AT-SPI2 accessibility/widget tree with desktop-global pixel extents | Python helper (`lib/atspi-tree.py`) over `gi.repository.Atspi` |
| `desktop_screenshot` | full desktop / one output / one window, returned as an image block | `grim` (wlr-screencopy); window capture tries `niri msg action screenshot-window` first |
| `desktop_mouse` | move / click / down / up / drag / scroll | raw Wayland client for `zwlr_virtual_pointer_v1` (`lib/wayland-pointer.js`); wheel via `ydotool` |
| `desktop_key` | type text (CJK included), key combos, single keys | `wtype` (virtual-keyboard protocol), `ydotool` keycode fallback |

The system prompt carries one guidance section (`tool:computer-use`, order 1610)
describing the workflow: list windows → tree/screenshot → act → verify.

## Coordinate systems

- The accessibility tree reports **desktop-global logical pixels**; niri IPC and
  `desktop_mouse` speak the same coordinates. Multi-monitor bounding boxes with
  negative origins work: the client converts to the normalized
  `zwlr_virtual_pointer_v1.motion_absolute` space using the bounding box from
  `niri msg --json outputs` (`logical` per output).
- `desktop_screenshot` may downscale (`grim -s`) to fit the attachment store's
  dimension limit (2000 px per side); its result text states the exact mapping
  from image pixels back to desktop coordinates.

## Design notes

- **Absolute pointer input is hand-rolled.** ydotool 1.0.4's daemon creates a
  relative-only uinput device (`capabilities/abs: 0`), so `mousemove -a` cannot
  target pixels. niri implements `wlr-virtual-pointer-unstable-v1` natively, and
  the protocol subset needed (registry walk, bind, `create_virtual_pointer`,
  `motion_absolute`, `button`, `frame`, destroy) is small enough for a
  dependency-free wire-protocol client. There is deliberately no wheel axis in
  the client — wheel detents go through `ydotool mousemove -w`, whose
  REL_WHEEL semantics are unambiguous.
- **Keyboard uses wtype, not ydotool, for text.** wtype uploads its own keymap
  over the virtual-keyboard protocol, so Unicode/CJK typing works; ydotool
  `type` is ASCII-oriented. Combos are keysym-based (`ctrl+shift+a`); the
  ydotool fallback maps names onto raw evdev keycodes.
- **Window screenshots have a fallback.** `niri msg action screenshot-window`
  has been observed to return success while producing no file and no clipboard
  image on some builds (this deployment included). The tool polls the
  configured `screenshotDir` for a new image and, on timeout, focuses the
  window (`focus-window --id`) and captures the full screen through grim,
  stating clearly in the result what happened.
- **The a11y tree is coverage-limited by the ecosystem, not the compositor.**
  There is no Wayland widget-tree protocol; AT-SPI2 over D-Bus is the only
  structured source, and it works under niri. GTK4/Qt register always, Firefox
  connects when an assistive client reads the bus, Chromium/Electron apps
  (browsers, VS Code, Obsidian, QQ) only expose their tree when launched with
  `ACCESSIBILITY_ENABLED=1`. The tree tool explains this in-band when the dump
  comes back empty, and the guidance section tells the model to fall back to
  screenshot + coordinates.
- The helper uses `gi.repository.Atspi` (shipped by `at-spi2-core`), so the
  separate `python-atspi` package is not needed.

## Configuration (preset row)

```yaml
- id: tool-computer-use
  name: dsh-plugin-computer-use
  # config:
  #   screenshotDir: ~/Pictures/Screenshots  # where niri screenshot-window writes
  #   maxTreeNodes: 400
  #   maxTreeDepth: 12
  #   keyboardTransport: wtype               # or ydotool
```

## Mounting

An agent-plane row in `profile/agent-presets/context-compact/agent.cordis.yml`.
Like `@deepseek-ai/dsh-tool-fs`, the plugin is a pure registrar into the host
`tools` registry (inject: `tools`, `systemPrompt`) and provides no service, so
the row needs no isolate realm. Deploy both halves:

```bash
rsync -a --delete --exclude 'node_modules/' \
  plugins/dsh-plugin-computer-use/ \
  ~/.dsh/profiles/node_modules/dsh-plugin-computer-use/
cp profile/agent-presets/context-compact/agent.cordis.yml \
  ~/.dsh/.agent-presets/context-compact/agent.cordis.yml
```

The agent preset is deployed as a copy under `~/.dsh/.agent-presets/`, unlike
plugins (which live under `profiles/node_modules/`). A new DSH process is
required after either changes.

## Security posture

The tools execute real desktop input and window management with no permission
surface — no approval hook, no sandbox. That is deliberate for a single-user
local deployment: mount the row only in presets whose sessions you trust. The
guidance text instructs the model to prefer the a11y tree and to verify
destructive actions with screenshots, which is convention, not enforcement.

## System dependencies (Arch)

```bash
pacman -S at-spi2-core grim ydotool wtype
systemctl enable --now ydotoold   # wheel-scroll path only
```

`ydotoold` runs as the user by default (`$XDG_RUNTIME_DIR/.ydotool_socket`); the
plugin discovers that path automatically.

## Test

```bash
node tests/dsh-computer-use-smoke.mjs
```

The test imports the installed runtime copy (sync first). It includes two live
checks that skip cleanly when their socket is absent: the raw Wayland handshake
against the real compositor, and an AT-SPI dump against the session bus.
