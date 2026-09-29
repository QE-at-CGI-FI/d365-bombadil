// Bombadil specification for the D365 Finance & Operations test app.
// Correctness checks are Bombadil's browser defaults (noHttpErrorCodes,
// noUncaughtExceptions, noUnhandledPromiseRejections, noConsoleErrors) plus
// its default action generators (clicks, inputs, navigation, reload,
// scroll, ...), with two custom properties layered on top —
// `notAuthorizedBannerResolves` and `gridQuickFilterNarrowsNotWidens`, both
// explained where they're defined below.
//
// An earlier version of this file tried excluding the default `reload` and
// replacing it with a rate-limited custom one, to reduce how often the app
// gets reloaded in quick succession (see "Known limitations" in the
// README). That didn't work: the trace showed the replacement's own gate
// cell correctly computing `false` right after a reload, yet Bombadil kept
// choosing `Reload` anyway at the same ~1-1.2s cadence as before — strong
// evidence `Reload` (like `Wait`) is offered as a baseline action
// independent of the spec's exports, not something togglable by omitting
// it from `defaults/actions`.
//
// Also tried the manual's other documented lever: `weighted`, which sets
// relative probabilities *between* actions rather than excluding one.
// Rebuilt the default-actions bundle from its individual named generators
// (`waitOnce`, `scroll`, `clicks`, `inputs`, `back`, `forward`, `reload`,
// `navigation`) via `weighted([[1, reload], [10, everything-else], ...])`,
// a 10:1 penalty against `reload` specifically, on the theory that giving
// D365's silent Azure AD token refresh more clear air between reloads might
// stop it from tripping `notAuthorizedBannerResolves` below. Measured, not
// just assumed: a 3-minute run with that bundle exported still fired
// `Reload` 148 times (~1.2s apart on average) — statistically indistinguishable
// from the un-weighted cadence the previous paragraph already recorded.
// Confirms the same conclusion from a second angle: `Reload`'s cadence
// isn't reachable from the spec at all, whether by omission, replacement, or
// down-weighting inside a custom bundle. Reverted.
export * from "@antithesishq/bombadil/browser/defaults";

import { always, eventually, now } from "@antithesishq/bombadil";
import { extract, actions, registerCustomAction } from "@antithesishq/bombadil/browser";

// .env.rel and .env.build currently share the same sign-in account (only
// the URL differs), so reading credentials from .env.rel covers both.
// Point this at .env.build instead if that ever changes.
import envText from "../.env/.env.rel" with { type: "text" };

function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    values[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return values;
}

const credentials = parseEnv(envText);
const USER_NAME = credentials.USER_NAME ?? "";
const PASSWORD = credentials.PASSWORD ?? "";

// Modeled after ts-pw-d365-ce-fo's fo-mixins/login.ts (login_to_fo), which
// drives the same three steps via Playwright's role-based locators:
//   textbox "Enter your email, phone, or Skype." -> button "Next"
//   textbox "Enter the password for <email>"     -> button "Sign in"
//   button "Yes"                                    (stay signed in?)
// Custom actions only get `document`/`window` here, not a Playwright `Page`,
// so there's no `getByRole` available — these are plain DOM queries against
// the same aria-label/value attributes that `getByRole`'s accessible-name
// matching would resolve to, checked directly against the live page rather
// than assumed. None of it depends on Microsoft's own internal element ids
// (e.g. "i0116"), matching that project's approach of naming elements the
// way a user would rather than by implementation detail.
function byAriaLabel<T extends HTMLElement>(document: Document, label: string): T | null {
  return document.querySelector<T>(`[aria-label="${label}"]`);
}

function submitButton(document: Document, value: string): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(`input[type="submit"][value="${value}"]`);
}

const microsoftSignInVisible = extract((state) => {
  const doc = state.document;
  return Boolean(
    byAriaLabel(doc, "Enter your email, phone, or Skype.") ||
      doc.querySelector('input[aria-label^="Enter the password for "]') ||
      submitButton(doc, "Yes"),
  );
});

// Each step here submits a form that causes a real, full-page navigation
// (this is a classic WS-Federation redirect flow, not an in-page SPA
// transition) — confirmed by reproducing "Execution context was destroyed,
// most likely because of a navigation" from an earlier version of this
// action that filled a field, clicked submit, *then kept polling* the same
// `document` reference afterward waiting for the next step to appear. This
// handler instead does exactly one fill-and-click per invocation and
// returns immediately, without touching `document` again post-click.
// Bombadil's own state loop (extract -> check -> act -> wait -> re-extract)
// naturally re-observes the page after the navigation settles and, since
// `microsoftSignInVisible` is still true on whichever step comes next,
// offers this action again to drive the following step.
const microsoftSignIn = registerCustomAction(
  "microsoftSignIn",
  async (document: Document, _window: Window, username: string, password: string) => {
    const passwordLabel = `Enter the password for ${username}`;

    // Email step: textbox "Enter your email, phone, or Skype." -> button "Next".
    const email = byAriaLabel<HTMLInputElement>(document, "Enter your email, phone, or Skype.");
    if (email) {
      email.value = username;
      email.dispatchEvent(new Event("input", { bubbles: true }));
      submitButton(document, "Next")?.click();
      return;
    }

    // Password step: textbox "Enter the password for <email>" -> button "Sign in".
    const passwordField = byAriaLabel<HTMLInputElement>(document, passwordLabel);
    if (passwordField) {
      passwordField.value = password;
      passwordField.dispatchEvent(new Event("input", { bubbles: true }));
      submitButton(document, "Sign in")?.click();
      return;
    }

    // "Stay signed in?" prompt: button "Yes".
    submitButton(document, "Yes")?.click();
  },
);

export const signIn = actions(() => {
  return microsoftSignInVisible.current ? [microsoftSignIn(USER_NAME, PASSWORD)] : [];
});

// D365 occasionally shows a transient error banner — "You are not
// authorized to login with your current credentials. You will be
// redirected to the login page in a few seconds." — that no default
// property catches (it's ordinary page content: no console error, no
// uncaught exception, presumably a 200 response). Observed once, correlated
// with two `Reload`s ~1.15s apart just before it, suggesting a race with
// D365's own silent Azure AD token refresh; the exact trigger isn't
// confirmed, and there's no way to stop Bombadil from reaching it — reload
// is a baseline action offered independent of the spec's exports (see the
// comment on the defaults re-export above), so it can't be rate-limited or
// removed from here.
//
// Given that, this verifies the banner's own claim about itself instead of
// trying to prevent it: once shown, it must be gone again within 10s (the
// banner says "a few seconds"; 10s leaves headroom for automation overhead
// without masking a genuine hang). This is the one custom property in this
// spec — everything else stays default.
const notAuthorizedBannerVisible = extract(
  (state) =>
    state.document.body?.textContent?.includes(
      "You are not authorized to login with your current credentials",
    ) ?? false,
);

export const notAuthorizedBannerResolves = always(
  now(() => notAuthorizedBannerVisible.current).implies(
    eventually(() => !notAuthorizedBannerVisible.current).within(10, "seconds"),
  ),
);

// D365 F&O's dashboard sits on a loading splash (no clickable elements at
// all, by Bombadil's own reckoning) for longer than Bombadil's default
// `Wait` action is willing to wait (~1s), which otherwise exhausts every
// default action and gives up with "no actions available" before the
// workspace ever renders. This offers a longer, explicit wait for up to 10s.
//
// It's exported unconditionally (always offered, alongside the defaults)
// rather than gated by an extractor cell: an earlier attempt gated it on
// "does a button/link/input exist anywhere in the DOM", but that went true
// immediately — elements matching that selector (e.g. top nav bar buttons)
// exist in the markup well before Bombadil's own clickability check
// considers anything on the page interactable, so the gate never triggered.
// Instead, the handler itself re-checks live, each time it runs, and returns
// immediately once real content is up — so once the app has loaded this is
// just an occasional near-instant no-op action, not a real 10s stall.
const waitForLoad = registerCustomAction(
  "waitForLoad",
  async (document: Document, _window: Window, timeoutMs: number) => {
    const start = Date.now();
    const loaded = () =>
      document.querySelectorAll("button, a[href], input, select, textarea").length > 0;
    while (Date.now() - start < timeoutMs && !loaded()) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  },
);

export const waitForAppToLoad = actions(() => [waitForLoad(10_000)]);

// Explored via playwright-cli against the rel tenant's vendor invoice
// journal (?mi=VendInvoiceJournal&cmp=DEMF) to ground the rest of this file
// in real data and a verified-working interaction, rather than guessing:
//
// - Seed data: vendor account "CGI-501", currency "EUR", invoice amounts
//   ranging from 565.55 to 5,800.00 (as rendered, e.g. "4,500.00").
// - The grid's "Filter" quick-search combobox (role=combobox,
//   aria-label="Filter") is a shared D365 platform control — the same
//   pattern showed up with an id like "vendinvoicejournal_1_..." on this
//   page, implying it's reused across many list pages, not unique to this
//   one. Confirmed narrowing the visible grid from 18 rows to 1 (header
//   only) by typing a nonexistent value and pressing Enter, and confirmed
//   clearing it restores all 18.
// - That Enter press only worked with a *raw DOM* KeyboardEvent when
//   `keyCode`/`which`/`charCode` were set explicitly, alongside `key`/
//   `code`. A first attempt with only `key: "Enter"` (matching typical
//   modern event-handling advice) silently did nothing — Playwright's own
//   `press()` sends a trusted, OS-level key event that custom actions here
//   can't reach (only `document`/`window` are available), and this D365
//   control apparently still branches on the legacy `keyCode`/`which`
//   properties. Worth remembering for any future custom action that needs
//   to simulate Enter/Tab/etc. from inside `registerCustomAction`.
function pressEnter(input: HTMLInputElement) {
  const eventInit = {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    charCode: 13,
    bubbles: true,
    cancelable: true,
  };
  input.dispatchEvent(new KeyboardEvent("keydown", eventInit));
  input.dispatchEvent(new KeyboardEvent("keypress", eventInit));
  input.dispatchEvent(new KeyboardEvent("keyup", eventInit));
}

function gridQuickFilterInput(document: Document): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[role="combobox"][aria-label="Filter"]');
}

// Custom action: navigates straight to the vendor invoice journal, since
// reaching it via clicks alone (multiple menu levels deep) is unlikely
// within a short exploration run — without this, the quick-filter action
// and property below would rarely, if ever, get exercised.
//
// Guarded on *not already being there* (via the `onInvoiceJournal` cell
// below), unlike waitForAppToLoad — first version offered this
// unconditionally on every state and it backfired: this page loads far
// slower than the dashboard splash, and Bombadil kept re-triggering the
// navigation roughly every 2s (confirmed in a trace: 14 invocations across
// one 30s run), interrupting the load before the grid, and the quick
// filter input inside it, ever had an uninterrupted stretch to finish
// rendering — `setGridQuickFilter` never fired once in that run. Only
// offering this when we're not already mid-flight to (or on) that page
// lets it actually settle.
const onInvoiceJournal = extract((state) => state.navigationHistory.current.url.includes("mi=VendInvoiceJournal"));

const goToInvoiceJournal = registerCustomAction("goToInvoiceJournal", async (_document, window) => {
  window.location.assign(`${window.location.origin}/?mi=VendInvoiceJournal&cmp=DEMF`);
});

export const navigateToInvoiceJournal = actions(() => (onInvoiceJournal.current ? [] : [goToInvoiceJournal()]));

const gridQuickFilterVisible = extract((state) => Boolean(gridQuickFilterInput(state.document)));

const setGridQuickFilter = registerCustomAction(
  "setGridQuickFilter",
  async (document: Document, _window: Window, value: string) => {
    const input = gridQuickFilterInput(document);
    if (!input) {
      return;
    }
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    pressEnter(input);
  },
);

// Values chosen from what exploration actually found in this grid, plus
// boundaries around it: a known-good vendor account and currency, two real
// invoice amounts (one as-rendered with a thousands separator, one without,
// covering both formats), zero and a negative number (neither of which
// should match anything as an account/currency/amount), a value guaranteed
// not to exist, and clearing the filter entirely.
export const gridQuickFilterEntry = actions(() => {
  if (!gridQuickFilterVisible.current) {
    return [];
  }
  return [
    setGridQuickFilter("CGI-501"),
    setGridQuickFilter("EUR"),
    setGridQuickFilter("4,500.00"),
    setGridQuickFilter("565.55"),
    setGridQuickFilter("0"),
    setGridQuickFilter("-1"),
    setGridQuickFilter("ZZZ-DOES-NOT-EXIST"),
    setGridQuickFilter(""),
  ];
});

// Property: filtering a grid should only ever narrow what's visible, never
// widen it beyond what was showing the last time the filter was empty.
// Deliberately doesn't assert *which* rows should match (the quick filter's
// exact search scope across columns isn't confirmed — asserting something
// column-specific here risked encoding a wrong guess as a "property"), just
// that typing something in can't ever increase the row count versus the
// baseline. General enough to hold for any D365 grid using this shared
// control, not just the vendor invoice journal.
let lastRowCountAtEmptyFilter: number | null = null;

const gridQuickFilterState = extract((state) => {
  const input = gridQuickFilterInput(state.document);
  if (!input) {
    return null;
  }
  const rowCount = state.document.querySelectorAll('[role="row"][aria-rowindex]').length;
  const filterValue = input.value.trim();
  if (filterValue === "") {
    lastRowCountAtEmptyFilter = rowCount;
  }
  return { filterValue, rowCount, baselineCount: lastRowCountAtEmptyFilter };
});

export const gridQuickFilterNarrowsNotWidens = always(() => {
  const current = gridQuickFilterState.current;
  if (!current || current.filterValue === "" || current.baselineCount === null) {
    return true;
  }
  return current.rowCount <= current.baselineCount;
});
