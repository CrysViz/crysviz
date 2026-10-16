# CrysViz widget mode

How the embeddable viewer works, how to put it in another application, and
what to keep true when you change it. For humans and agents alike.

`?widget=1` turns the full CrysViz app into a compact viewer for an `<iframe>`:
just the 3D structure, a menu behind the logo, and an optional message channel
the host page can drive. It is the same `docs/` app, not a separate build;
everything widget-specific is gated on `body.widget-mode` or an opt-in URL
parameter, so the full app is untouched.

Companions: `docs/widget-embed-demo.html` is a working host page (trajectory
player driving the widget). The README's "Widget mode / embedding" section has
the payload examples (`frameKinds`, `menuLinks`), but predates the logo menu:
where it and the code disagree, the code and this guide win.

## What the viewer shows

- **The structure**, with spin arrows on every periodic image and the
  composition legend (lower right, locked open).
- **Axes gizmo** (lower left), a/b/c letters on the arrows.
- **Camera control** (top right): view along a, b or c, and reset.
- **The CrysViz logo** (top left) is the menu:
  - **Open in CrysViz**: the same structure (current frame) in the full app,
    new tab.
  - **Structures**: As loaded / Conventional / Primitive. The cells are built
    in the browser with moyo, and the magnetic moments are rotated and
    remapped onto the new cell (`ui/WidgetSpinRemap.js`); a cell the magnetic
    order cannot live in (a magnetic supercell) is greyed out. A payload with
    `frameKinds` lists its own precomputed cells instead, and no moyo runs.
  - **Shading**: Metallic / Matte / Cel shading, plus Ray tracing / Path
    tracing with `tracers=1`.
  - **Bonds**, **Polyhedra** toggles (polyhedra start off).
  - **Download POSCAR / CIF**, written in the browser from the cell shown.
  - The host's own **links** (`menuLinks`), opened in a new tab.
- **A boot-error notice** ("CrysViz could not load this structure.") instead of
  a blank frame when the structure cannot be loaded.

A multi-frame session (a trajectory, or several structures) has no player in
the widget: the host steps it through the control channel below.

## Where things live

```
docs/host/early.js           runs first: detects ?widget, hides the full-UI
                             chrome before it can flash, starts the session
                             receiver for #load-message / #load-opener
docs/io/FileURLLoader.js     the #load-file= / #load-url= routes, and
                             getLaunchSource() (what "Open in CrysViz" re-sends)
docs/io/SessionReceiver.js   the postMessage hand-over (no imports on purpose:
                             early.js loads it before the app graph)
docs/ui/WidgetMode.js        the chrome and the menu: initWidgetMode()
docs/ui/WidgetSpinRemap.js   moment remapping for Conventional/Primitive
                             (pure, imports nothing)
docs/ui/WidgetControl.js     the host control channel (control=1)
docs/styles/widgetMode.css   the widget's layout rules (see STYLE.md)
docs/widget-embed-demo.html  a reference host page
tools/devserver.py           `make serve`: no-cache + CORS, as production
```

## The URL contract

```
https://crysviz.org/index.html?widget=1[&control=1][&tracers=1][&theme=dark|light][&prefs=1]#<route>
```

| Query | Effect |
|---|---|
| `widget=1` | widget mode (required) |
| `control=1` | install the host control channel (otherwise no message listener exists) |
| `tracers=1` | offer Ray/Path tracing in Shading (downloads the tracer pipelines; skipped by default) |
| `theme=dark` / `light` | force the UI theme at boot (default: follow the OS); not persisted |
| `prefs=1` | re-apply per-structure customisations this browser saved in the full app (off by default: the widget has no UI to see or reset them) |

The hash says where the structure comes from:

| Route | Use it when |
|---|---|
| `#load-file=<name>\|<base64>` | small text files; both parts URI-encoded, the content base64 of the file's UTF-8 text (it is decoded as text, so binary files such as ASE `.traj` need one of the next two). Simple, but the URL is ~1.4× the file and browsers cap URL length (Chromium ~2 MB, others less) |
| `#load-url=<url>[\|<name>]` | the file is on a server. http(s) only, fetched without cookies, so the server must send `Access-Control-Allow-Origin` (`*` also covers a sandboxed, opaque-origin widget) |
| `#load-message` | large or dynamic data: the host posts it (below). No size limit, no encoding |
| `#load-opener` | internal: the full app receiving a session from the widget's "Open in CrysViz" |

The file can be anything CrysViz reads (the format is detected from the
contents: POSCAR, CIF, extended XYZ, OUTCAR, QE output, ASE `.traj`, ...) or a
`.crysviz` session: JSON with `frames` (`elements`, `lattice`, `positions`,
optional `spins`), `selectedFrameIndex`, `display` toggles, and the widget-only
keys `frameKinds` and `menuLinks` (README). The full app ignores the
widget-only keys.

## Integrating into an existing application

**1. Host CrysViz.** Point at `https://crysviz.org/index.html`, or serve
`docs/` yourself. A self-hosted copy must send `Access-Control-Allow-Origin`
on its files (a sandboxed iframe fetches its own modules and WASM
cross-origin) and serve `.wasm` as `application/wasm`. Locally, `make serve`
sends the CORS header (as GitHub Pages does for crysviz.org).

**2. Add the iframe.** It needs no `allow-same-origin`, and should not get it:

```html
<iframe id="viewer" title="Crystal structure"
  sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads"
  referrerpolicy="no-referrer" width="480" height="480"></iframe>
```

`allow-popups*` is for "Open in CrysViz" and `menuLinks`, `allow-downloads`
for Download POSCAR/CIF. In the opaque origin there is no browser storage and
no web workers; the widget falls back to defaults and main-thread work.

**3. Send the structure.** For anything beyond a small file, use
`#load-message`. The widget asks, the host answers, and only the iframe's
direct parent is listened to:

```js
const CRYSVIZ = 'https://crysviz.org/index.html';
const viewer = document.getElementById('viewer');

// Listen BEFORE setting src: `awaitingSession` and `ready` are posted during
// start-up and a listener attached later misses them.
window.addEventListener('message', (e) => {
  if (e.source !== viewer.contentWindow) return;          // only our iframe
  const d = e.data;
  if (!d || d.source !== 'crysviz-widget') return;
  if (d.type === 'awaitingSession') {
    const bytes = new TextEncoder().encode(fileText);      // or an ArrayBuffer / Blob
    viewer.contentWindow.postMessage(
      { target: 'crysviz-widget', type: 'loadSession', name: 'NaCl.cif', data: bytes.buffer },
      '*', [bytes.buffer]);                                 // transferred, not copied
  }
});
viewer.src = `${CRYSVIZ}?widget=1#load-message`;
```

`loadSession` takes `name` (≤255 chars, its extension helps format detection),
`data` (string, ArrayBuffer, typed array or Blob) and an optional `format`.
The widget waits 60 s for it. Posting `loadSession` before `awaitingSession`
also works: the receiver is installed before the app loads.

**4. Optionally, drive it** (`control=1`): step a trajectory, show one of
several structures, link cameras. See the protocol below and
`docs/widget-embed-demo.html` for a full player.

### The control channel (`control=1`)

Commands, host → widget: `{ target: 'crysviz-widget', type, ... }`

| type | effect |
|---|---|
| `getState` | widget replies `state` |
| `setFrame { index, recenter? }` | show frame `index` (clamped). The camera stays put (a trajectory step); `recenter: true` also refits it (the frames are different structures) |
| `fitView` | recentre and refit the camera to the shown frame, keeping the viewing direction |
| `play { fps? = 10, loop? = true }` | step through the frames (fps capped at 60) |
| `pause` | stop |
| `getCamera` | widget replies `camera` |
| `setCamera { view }` | turn and zoom to `view`; keeps this widget's rotation centre and pan |

Notifications, widget → host: `{ source: 'crysviz-widget', version: 1, type, ... }`

| type | when |
|---|---|
| `ready { frameCount, index, camera: true }` | once, after the structure loaded. `camera: true` advertises getCamera/setCamera/camera; hide camera features from widgets without it |
| `state { frameCount, index, playing }` | reply to `getState` |
| `frame { frameCount, index }` | whenever the shown frame changes |
| `camera { view }` | the **user** moved the camera (at most once per animation frame), or reply to `getCamera`. Moves made by host commands are never reported |

A `view` is relative, so it carries over between structures of different size:
`direction` (unit vector, rotation centre → camera), `up` (perpendicular to
it), `distance` (camera distance over the distance that fits the shown
structure, so ~1 after a fit) and `zoom` (orthographic zoom).

**Linking two widgets** (compare two structures from the same angle): relay
each widget's `camera` to the other as `setCamera`, while the link is on. To
align once (when the link is switched on), send `getCamera` to one and relay
the reply. There is no echo loop, because host-driven moves are not reported.

```js
function relay(from, to) {
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== from.contentWindow || d?.source !== 'crysviz-widget' || d.type !== 'camera') return;
    if (linked) to.contentWindow.postMessage({ target: 'crysviz-widget', type: 'setCamera', view: d.view }, '*');
  });
}
relay(left, right);
relay(right, left);
```

**Several structures in one widget**: load them as the frames of one session
and switch with `setFrame { index, recenter: true }`. One widget is much
cheaper than reloading the iframe per structure.

### What the widget trusts

- Commands only from `window.parent` carrying `target: 'crysviz-widget'`;
  everything else is ignored. Replies go to the first controller's origin
  (`'*'` only for an opaque-origin host, still only to the parent).
- A `loadSession` only from the parent (`#load-message`) or the opener
  (`#load-opener`), checked by `event.source`, which the browser sets.
- `#load-url` only http(s), without credentials. `menuLinks` only http(s) URLs
  with short non-empty labels; invalid entries are dropped.

## Changing widget code

- **Gate everything.** Widget behaviour runs only under `body.widget-mode` or
  an opt-in parameter. A change that alters the full app is a bug.
- **Keep the default embed lean.** Heavy features load on opt-in only, by
  dynamic import (the tracer pipelines behind `tracers=1`). WidgetControl adds
  no listener without `control=1`.
- **The protocol is a public API.** Add messages and fields; never rename or
  remove them, never change what an existing one does by default (`setFrame`
  stays `recenter: false` unless asked). Advertise a new capability in `ready`
  (as `camera: true` does) so hosts can tell old widgets from new ones.
- **Host commands are not user actions.** Anything a command does must not
  come back as a notification (`hostMove` in WidgetControl.js), or linked
  widgets feed back into each other.
- **Assume an opaque origin.** No storage, no workers, `event.origin` is
  `'null'` (not a valid `postMessage` target: use `'*'` towards
  `window.parent`). Guard storage in try/catch and keep a main-thread path.
- **Widget-only payload keys stay widget-only** (`frameKinds`, `menuLinks`);
  the full app must keep loading such a session as a plain one.
- Styling follows `STYLE.md`: rules in `docs/styles/widgetMode.css`, tokens
  only, no CSS in JS.

## Traps

- **A listener added after the iframe loads misses `ready` and
  `awaitingSession`.** Attach before setting `src`, or ask with `getState`.
- **Different structures as frames need `recenter: true`.** Without it the
  camera keeps the last frame's framing and a larger or shifted cell can sit
  off-screen.
- **URL length.** `#load-file=` fails silently in some browsers past their cap;
  use `#load-message`. "Open in CrysViz" switches to a postMessage hand-over
  above 1 MB for the same reason.
- **`#load-url` without CORS headers** shows the boot error, not a hint about
  CORS. Check the data server's `Access-Control-Allow-Origin` first.
- **A restored session can carry display state the widget overrides** (axes
  always on, polyhedra off, feature locks on). Set those in `initWidgetMode`,
  not by trusting the payload.
- **Synthetic `PointerEvent`s cannot drive the camera in tests**
  (TrackballControls' `setPointerCapture` rejects them); use Playwright's
  `page.mouse`.

## Verifying a change

```
tools/browsertest/run.sh tests/widget*.test.js        # all widget tests
make serve   # then open /widget-embed-demo.html (?transport=hash for #load-file)
```

| Test | Covers |
|---|---|
| `widgetmode` | the chrome, menu and boot |
| `widgetmodecells` | Conventional/Primitive via moyo, spin remapping |
| `widgetmodeframes` | `frameKinds` cells |
| `widgetmenulinks` | `menuLinks` validation and rendering |
| `widgettheme` | `theme=` |
| `widgettracers` | `tracers=1` |
| `widgetoverflow` | a long menu and a many-species legend stay on the canvas |
| `widgetloadmessage` | `#load-message`, `#load-url`, the "Open in CrysViz" hand-over, in a real sandboxed iframe |
| `widgetcontrol` | the control channel, frames, recentre, camera read/set/report, no echo |

A new message or payload key gets a check in the matching test. Anything that
touches origins, storage or workers is checked in a sandboxed iframe
(`widgetloadmessage` shows how), not only at the top level.

## Conventions

- The message tags are fixed: `target: 'crysviz-widget'` host → widget,
  `source: 'crysviz-widget'` widget → host (`crysviz-app` for the full app's
  `#load-opener`). Notifications carry `version: 1`.
- Keep the protocol comment at the top of `WidgetControl.js` and the tables
  here in step with the code.
- Comment why, not what, as everywhere else in CrysViz.
