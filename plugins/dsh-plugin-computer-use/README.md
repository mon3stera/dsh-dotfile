# dsh-plugin-computer-use

Five agent tools that let a DSH session see and operate the niri/Wayland
desktop the DSH process runs in:

- **desktop_windows** — window list, focus, close, fullscreen (niri IPC)
- **desktop_tree** — AT-SPI2 accessibility/widget tree with click-ready pixel
  extents (spawned Python helper over `gi.repository.Atspi`)
- **desktop_screenshot** — full desktop / output / window capture returned as
  a model-visible image block (grim, with a `niri screenshot-window` path)
- **desktop_mouse** — absolute move/click/drag over a dependency-free raw
  Wayland `zwlr_virtual_pointer_v1` client; wheel via ydotool
- **desktop_key** — text typing (Unicode/CJK via wtype), key combos, single keys

See `docs/computer-use.md` for design notes, deployment (including the
`~/.dsh/.agent-presets/` preset copy), and the security posture. The tools
execute real desktop input without a permission surface — mount only in
presets you trust.

```bash
node tests/dsh-computer-use-smoke.mjs   # after the rsync into profiles/node_modules
```
