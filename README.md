# d365-bombadil
Platform products are hard to automate against. Let's see how Bombadil works with D365.

## Getting started

[Bombadil](https://antithesishq.github.io/bombadil/index.html) is property-based
UI testing: instead of scripted steps, it randomly explores the app while
checking that a set of properties always hold, reporting any violation it
finds.

`bombadil/specification.ts` re-exports Bombadil's default properties and
default actions as-is (`noHttpErrorCodes`, `noUncaughtExceptions`,
`noUnhandledPromiseRejections`, `noConsoleErrors`, plus the default
click/input/navigation/scroll/reload actions), with a handful of custom
properties and actions layered on top — all grounded in exploring the real
rel tenant with `playwright-cli` rather than guessed:

**Custom properties:**

- `notAuthorizedBannerResolves` — see "Known limitations" below for why.
- `gridQuickFilterNarrowsNotWidens` — a grid's quick-filter search should
  only ever narrow the visible rows, never widen them beyond what was
  showing the last time the filter was empty. See "Vendor invoice journal
  exploration" below.

**Custom actions (infrastructure, not test logic):**

- Fills in the Microsoft sign-in form using the credentials in
  `.env/.env.rel`, since the D365 origin redirects straight to a login page
  that the default actions can't get past on their own. Modeled after the
  role-based locator strategy in
  [`ts-pw-d365-ce-fo`](../ts-pw-d365-ce-fo)'s `fo-mixins/login.ts` (same
  accessible names — "Enter your email, phone, or Skype.", "Next", "Enter
  the password for `<email>`", "Sign in", "Yes" — translated to plain DOM
  queries against `aria-label`/`value`, since a Bombadil custom action only
  gets `document`/`window`, not a Playwright `Page`). Each step fills and
  clicks in a single call with no waiting afterward — Microsoft's sign-in
  does a real full-page navigation between steps, so anything that kept
  polling `document` after the click hit "Execution context was destroyed";
  Bombadil's own state loop naturally re-observes the next step instead.
- Waits up to 10s for real content to appear, since D365's dashboard sits on
  a loading splash screen longer than Bombadil's default `Wait` action
  tolerates (see "Known limitations" below).
- Navigates to the vendor invoice journal grid and drives its quick-filter
  search with values found by exploration — see below.

### Install

```sh
npm install
```

This installs the `bombadil` CLI and its TypeScript types as a dev dependency.

### Run

```sh
npm test               # against .env/.env.rel
npm run test:build     # against .env/.env.build
```

Both wrap `./bombadil/run.sh`, which sources the matching `.env/` file and
runs `bombadil browser test`. Call the script directly to pass extra flags
through to it (npm's own `--` separator works too, e.g.
`npm test -- --headless`):

```sh
./bombadil/run.sh rel --headless --time-limit=5m --exit-on-violation
```

Output (trace, screenshots) is written to `bombadil-output/<env>/`. Inspect a
run with:

```sh
bombadil browser inspect bombadil-output/rel
```

### Vendor invoice journal exploration

Explored `?mi=VendInvoiceJournal&cmp=DEMF` (the vendor invoice journal grid)
with `playwright-cli` to ground input values and a new action/property in
real data and a verified-working interaction, rather than guessing:

- Seed data: vendor account `CGI-501`, currency `EUR`, invoice amounts
  ranging from `565.55` to `5,800.00` (as rendered). These feed
  `gridQuickFilterEntry`'s curated values, alongside boundaries (`0`, `-1`,
  a guaranteed-nonexistent string, and clearing the filter).
- The grid's "Filter" quick-search combobox (`role="combobox"`,
  `aria-label="Filter"`) is a shared D365 platform control (its id looked
  auto-generated per grid instance, e.g. `vendinvoicejournal_1_...`),
  reused across many list pages — not unique to this one grid. Confirmed it
  narrows the visible grid from 18 rows to 1 (header only) for a
  nonexistent value, and confirmed clearing it restores all 18.
- That confirmation only worked once Enter was dispatched as a raw DOM
  `KeyboardEvent` with `keyCode`/`which`/`charCode` set explicitly,
  alongside `key`/`code`. A first attempt with only `key: "Enter"` (typical
  modern guidance) silently did nothing — Playwright's own `press()` sends
  a trusted, OS-level key event that a Bombadil custom action can't reach
  (only `document`/`window` are available), and this D365 control
  apparently still branches on the legacy `keyCode`/`which` properties.
  Worth remembering for any future custom action simulating Enter/Tab/etc.

**Reachability caveat:** `goToInvoiceJournal` (the action that navigates
here) and `setGridQuickFilter` are correct — verified directly against a
live session — but in local runs so far, `setGridQuickFilter` has never
actually fired. This grid loads far slower than the dashboard splash, and
`Reload` (the same baseline action from "Known limitations" below,
un-gateable from the spec) kept firing every ~1-2s throughout — 59 times in
one 100s run — before the grid's own slow load ever got an uninterrupted
stretch to finish and render the quick filter input.
`gridQuickFilterNarrowsNotWidens` is real and will hold or fail whenever
that input does render; it just may need a much longer `--time-limit`, a
warmer network path, or a CI/Antithesis-scale run to actually see it.

### Known limitations

- **`noConsoleErrors` noise.** D365 F&O itself logs an `ERROR`-level console
  message during a normal dashboard load (`The data-dyn-container needs to
  be set when both the template and the target have children`, from
  `dyn-core.min.js`). Since `noConsoleErrors` is one of the default
  properties re-exported here, expect this to show up as a violation even
  with no real bug involved — it's platform noise, not something this test
  set introduced.

- **Slow initial load, worked around with `waitForAppToLoad`.** Without it,
  runs stopped almost immediately with `Error: no actions available` —
  verified this happens even with zero custom specification (plain
  `bombadil browser test <origin>`, no `.ts` file at all), headless or
  headed, regardless of `--time-limit`: D365's dashboard sits on its loading
  splash screen (no clickable elements, `scrollHeight` ~194px) for longer
  than Bombadil's default `Wait` action is willing to wait — around a
  second — so after one `Reload` and one `Wait` it exhausted every default
  action and gave up, well before the workspace tiles that were visible
  after a manual, several-second wait (via `playwright-cli`) ever rendered.
  `waitForAppToLoad` is offered on every state (cheaply — its handler
  re-checks live and returns immediately once real content exists, so it's
  a near-instant no-op once the app is up) and waits up to 10s otherwise.
  Bump the `10_000` in `specification.ts` if 10s isn't enough on a slower
  connection.

- **D365's "not authorized" banner is a real, confirmed Bombadil-vs-D365
  interaction, not a credentials or environment problem.** In more than one
  run, D365 has displayed "You are not authorized to login with your
  current credentials. You will be redirected to the login page in a few
  seconds." — not caught by any default property (it's ordinary page
  content: no console error, no uncaught exception, presumably a 200
  response). This was originally assumed to be transient/self-recovering,
  but a later run showed `notAuthorizedBannerVisible` staying `true`
  continuously for the rest of that run (12.8s and counting when the run
  ended), finishing in a real forced sign-out
  (`login.microsoftonline.com/.../wsfed?wa=wsignout1.0`) rather than a
  return to normal — so it doesn't reliably self-recover.

  Signing in manually with `playwright-cli` against the same tenant and
  account never hits this. The difference is Bombadil's own `Reload`
  action, fired continuously (~1-1.2s apart) as part of its exploration —
  `playwright-cli` runs one deterministic sequence and never forces a
  reload mid-session. In both runs where the banner appeared, a `Reload`
  landed within ~100ms beforehand. The working theory: D365 F&O runs its
  own silent Azure AD token/session refresh in the background, and a
  full-page `Reload` mid-refresh races it, tripping the app's own
  authorization guard into this state — and if Bombadil never lets up long
  enough for the refresh to complete undisturbed, the state doesn't clear
  on its own.

  Two attempts to fix this from `specification.ts` were tried and measured,
  not just assumed, and both failed the same way:
  1. Exclude the default `reload` and replace it with a rate-limited custom
     action. The replacement's own gate cell correctly computed `false`
     right after a reload, but Bombadil kept choosing `Reload` anyway at
     the same cadence.
  2. Rebuild the default-actions bundle from its individual named
     generators via the `weighted` combinator, giving `reload` a 10:1
     penalty against everything else. A measured 3-minute run still fired
     `Reload` 148 times, ~1.2s apart on average — statistically the same
     cadence as unweighted.

  Both point to the same conclusion: `Reload` (like `Wait`) is a baseline
  action the browser-test driver offers on a fixed cadence independent of
  anything a specification exports — not omission, substitution, or
  down-weighting reaches it. There's currently no way to stop Bombadil from
  reaching this state from the spec.

  Given that, `notAuthorizedBannerResolves` verifies the banner's own claim
  about itself instead of trying to prevent it: whenever it's showing, it
  must be gone again within 10s (the banner says "a few seconds"; 10s
  leaves headroom for automation overhead without masking a genuine hang).
  This is the one custom property in this spec — everything else stays
  default. Expect it to fail intermittently on `rel` for the reason above;
  that's a known, understood interaction with Bombadil's exploration
  strategy, not evidence of a D365 authorization bug.
