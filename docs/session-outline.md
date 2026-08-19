# Session Outline

`dsh-plugin-outline` adds a right-side outline to the DSH conversation view.

The outline contains user and steering messages from the current conversation. Each entry is truncated for scanning and keeps the stable chat anchor key. Clicking an entry scrolls the center conversation to the corresponding message and marks the selected entry.

## History Loading

DSH may resume a session from a tail history page. When `hasMore` is true, the outline shows a `加载更早消息` button above the message list. Clicking it first triggers ChatView's native `加载更早` control, preserving the conversation scroll anchor while prepending one history page; it falls back to the official `loadOlder()` session action only when the native control is unavailable. Opening the outline does not load history automatically, so long sessions remain responsive and users choose how far back to load.

The outline is mounted through `conversation.session.header.utilities` and uses a fixed right-side panel so it does not replace the built-in details panel. Its lower edge stays above the composer, and the panel is toggled from the header button. It starts collapsed: the component is session-scoped and remounts on every session switch, so defaulting to open would reopen the panel each time the user changed sessions.

## Install

Add the package to the web profile's Cordis patch:

```yaml
- insert:
    - id: dsh-plugin-outline
      name: dsh-plugin-outline
```

The entry must be the bare package name. The client bundle is located by resolving `<name>/package.json`, which a subpath such as `dsh-plugin-outline/client` cannot satisfy, so the browser half would never register — and that entry would also try to load the browser file in Node, where `window` is undefined.

Place `dsh-plugin-outline` under the profile's `node_modules` directory, then restart the profile once to load the package manifest. After that, normal client changes can be verified with a browser refresh when the profile serves the updated bundle.
