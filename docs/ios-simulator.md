# iOS Safari in the iOS Simulator (safaridriver)

There is no test phone. iOS Safari compatibility and the map's phone protocols
run in the iOS Simulator on a Mac, whose Safari is the real iOS WebKit engine,
driven through `safaridriver` (W3C WebDriver). `scripts/sim-phone/` holds the
client: `webdriver.ts` (sessions, navigation, scripts, pointer actions,
screenshots) and `gestures.ts` (a touch tap, a one-finger pan, a two-finger
pinch). Walks, selectors and read-outs belong to whoever runs them; nothing
here runs in CI besides the two unit tests.

## Prerequisites

- Xcode with an iOS runtime, and a booted simulator
  (`xcrun simctl list devices booted`).
- `safaridriver --enable`, run once by the Mac's owner: it asks for the
  account password. An agent never runs it.
- In the simulator: Settings → Safari → Advanced → Remote Automation on.
- One driver process, started and stopped by its owner, e.g.
  `safaridriver -p 4445` (http://127.0.0.1:4445). Scripts never start, stop or
  reconfigure it. `GET /status` answers `ready: false` while a session holds
  it.

A `session not created` answer that names remote automation means one of the
two switches above is off: stop and ask the owner. The client never retries it.

## Sessions

```ts
import { driverStatus, withSession } from "./scripts/sim-phone/webdriver";

const driver = "http://127.0.0.1:4445";
if (!(await driverStatus(driver)).ready) throw new Error("the driver holds another session");
await withSession(driver, async (s) => {
  console.log(s.capabilities); // safari:deviceName, safari:platformVersion, browserVersion
  await s.navigate("http://127.0.0.1:<port>/temoignages");
  return s.execute<string>("return JSON.stringify(window.__acPerf.dump())");
});
```

- The capabilities sent are `SIM_CAPS` as `alwaysMatch`, nothing else:
  `{browserName: "Safari", platformName: "iOS", "safari:useSimulator": true,
  "safari:deviceType": "iPhone"}`. The answer names the device and versions;
  quote it rather than assuming them.
- One session at a time, one per walk: check `GET /status` answers
  `ready: true` before asking for one. `withSession` deletes the session in
  `finally`, on a throw, and on Ctrl-C; when the walk threw, a failing delete
  (`invalid session id` after a crash) is logged and the walk's error is the
  one thrown.
- A new session starts with no site data (check it anyway: set a canary key in
  `localStorage` at the end of a session and look for it at the start of the
  next). `localStorage` keys are set on a page of the same origin that boots no
  map (any unknown path: the not-found page), then the walk navigates to the
  page under test.
- `execute` runs a function body (`return …`). The Web Inspector's `copy()`
  does not exist there: return the JSON string and write it to a file as is.
  A long wait is polled from node with short scripts, never one script longer
  than the script timeout.

## Input

- **Taps.** Drive the page with `touchTap` through `perform`. The element click
  endpoint starts a touch that never ends in the simulator (a `pointerdown`,
  no `pointerup`, no `click`).
- **iOS's hover-first rule.** WebKit fires no `click` for a tap whose
  `mouseover` changed the page; the visitor taps again. A walk that waits for
  the `click` event (a capture listener on `document`) and taps a second time
  reproduces what a visitor does; count those second taps. The panel's unit
  rows no longer trip it (on iOS a tap never sets their hover, `rowHover.ts`),
  nor does a territory on the map canvas (a touch's mousemove sets no map
  hover, `canvasHover.ts`); a walk still counts second taps.
- **Pan.** A one-finger `touchPan` moves the map. Check the effect (the centre
  moved on screen), and check that it did not become a tap (a selection).
- **Pinch.** safaridriver accepts a two-pointer touch sequence, but in the
  probe runs (iOS 26.0.1) the page saw one finger: the map panned and its zoom
  did not change. Use the page's own
  camera instead, and say so.
- A phone's bottom sheet at rest shows only its peek. A visitor raises it
  (a tap on the grip) to reach the rows and lowers it to use the map; a walk
  does the same.

## Build under test

A staging-shaped build carries the testing tools (`__TEST_TOOLS__`) without the
dev server:

```sh
VITE_APP_ENV=staging npm run build --workspace=@ac/web
npm run preview --workspace=@ac/web -- --host 127.0.0.1 --port <p> --strictPort
```

The simulator reaches the Mac's 127.0.0.1 ports directly. For outline files
served from another port, set `VITE_MAP_DATA_BASE` (e.g.
`http://127.0.0.1:<static port>/`) before the build.

## Limits

- **A desktop GPU and CPU.** The simulator renders with the Mac's GPU and runs
  on its CPU: it gives compatibility and counts, not phone timings. Timings
  from it are not compared with headless or phone figures.
- **No device memory limit.** WebContent is a Mac process with no jetsam: a
  tab that survives a walk here says nothing about an iPhone's tab survival.
- **No DevTools protocol.** No CPU or network throttling, no capture of a
  worker's requests, no worker targets.
- **Resource Timing across origins has names but no sizes** (without
  `Timing-Allow-Origin`); take byte counts from the files themselves. The
  page's own `__acPerf` empties the Resource Timing buffer, so a request list
  needs a `PerformanceObserver({type: "resource", buffered: true})` installed
  before the app.
- **Probes.** A staging build has no `window.__acMap` (DEV only) and records no
  map error. A measurement run that needs them applies a local patch to its
  build (expose `__acMap` under the testing tools, push map `error` events and
  console errors into arrays, wrap `window.Worker` to list the workers
  started) and says so; such a patch is never committed.
- **Readers that parse file names.** The flip PRs' reader (`phoneRead.mjs`,
  kept outside the repo with the walk scripts, not in this tree) splits a
  dump's name `<phone>-<mode>-<relief>-<n>.json` on `-` and reads every `.json`
  in its directory: the phone token holds no hyphen (`simiphone17pro`), and
  nothing else goes in that directory.
