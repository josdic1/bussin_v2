import { useEffect, useState, type ReactNode } from "react";
import "./install.css";

/*
 * Put Bussin on the home screen. Parents and counselors don't know how, so this tells
 * them exactly which button to press on the phone in their hand, one step at a time,
 * with an arrow pointing at where that button is.
 *
 * Android Chrome lets us show the real install box, so there it is one button.
 * iPhone never does, so there it is three steps. Apps like Gmail or Instagram open
 * links in their own browser, which can't install anything, so first we get them
 * into the real browser.
 *
 * An iPhone home-screen app keeps its own login, separate from Safari. So for
 * people who aren't signed in yet, this comes before the login screen.
 */

type Who = "parent" | "counselor" | "anyone";
type Platform = "ios-safari" | "ios-chrome" | "android-chrome" | "android-samsung" | "in-app" | "other";
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

const SKIP_KEY = "bussin.install.skipped";
const SKIP_DAYS = 7;

export function isInstalled() {
  return window.matchMedia?.("(display-mode: standalone)").matches
    || ("standalone" in navigator && (navigator as { standalone?: boolean }).standalone === true);
}

export function isPhone() {
  const ua = navigator.userAgent;
  return /iphone|ipod|android/i.test(ua) || /ipad/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
}

function platform(): Platform {
  const ua = navigator.userAgent;
  if (/FBAN|FBAV|Instagram|LinkedInApp|Line\/|Twitter|Snapchat|GSA\/|; wv\)/i.test(ua)) return "in-app";
  const ios = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  if (ios) return /CriOS|FxiOS|EdgiOS/i.test(ua) ? "ios-chrome" : "ios-safari";
  if (/android/i.test(ua)) return /SamsungBrowser/i.test(ua) ? "android-samsung" : "android-chrome";
  return "other";
}

function skippedRecently() {
  try {
    const at = Number(localStorage.getItem(SKIP_KEY));
    return at > 0 && Date.now() - at < SKIP_DAYS * 86_400_000;
  } catch { return false; }
}
function rememberSkip() {
  try { localStorage.setItem(SKIP_KEY, String(Date.now())); } catch { /* private mode: ask again next time */ }
}

// Android hands us the install box once, early. Catch it at load so it's ready when needed.
let deferred: InstallEvent | null = null;
const waiting = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as InstallEvent;
    waiting.forEach((notify) => notify());
  });
  window.addEventListener("appinstalled", () => { deferred = null; waiting.forEach((notify) => notify()); });
}
function useInstallEvent() {
  const [, bump] = useState(0);
  useEffect(() => {
    const notify = () => bump((n) => n + 1);
    waiting.add(notify);
    return () => { waiting.delete(notify); };
  }, []);
  return deferred;
}

// ---------- the little pictures of each button ----------

const ShareIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" /><path d="M8 10H6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-2" /></svg>;
const DotsIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" /></svg>;
const DotsRowIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>;
const MenuIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>;
const AddIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M12 8.5v7M8.5 12h7" /></svg>;

type Step = { text: ReactNode; icon?: ReactNode };
type Plan = { steps: Step[]; arrow: "bottom" | "bottom-left" | "top-right" | "bottom-right" | null; title: string };

function planFor(kind: Platform): Plan {
  switch (kind) {
    case "ios-safari": return {
      title: "3 taps on your iPhone", arrow: "bottom-left", steps: [
        { icon: <MenuIcon />, text: <>Tap <b>&#8801;</b> at the bottom, left of the web address. <small>Older iPhones: tap <b>Share</b> instead.</small></> },
        { icon: <ShareIcon />, text: <>Tap <b>Share</b>, then <b>Add to Home Screen</b>. <small>Scroll down if you don&rsquo;t see it.</small></> },
        { icon: <AddIcon />, text: <>Tap <b>Add</b>.</> }
      ]
    };
    case "ios-chrome": return {
      title: "3 taps on your iPhone", arrow: "top-right", steps: [
        { icon: <ShareIcon />, text: <>Tap the <b>Share</b> button at the top right, next to the web address.</> },
        { icon: <AddIcon />, text: <>Scroll down and tap <b>Add to Home Screen</b>.</> },
        { text: <>Tap <b>Add</b> in the top right corner.</> }
      ]
    };
    case "android-samsung": return {
      title: "3 taps on your phone", arrow: "bottom-right", steps: [
        { icon: <MenuIcon />, text: <>Tap the <b>menu</b> button (three lines) at the bottom right.</> },
        { icon: <AddIcon />, text: <>Tap <b>Add page to</b>, then <b>Home screen</b>.</> },
        { text: <>Tap <b>Add</b>.</> }
      ]
    };
    case "android-chrome": return {
      title: "3 taps on your phone", arrow: "top-right", steps: [
        { icon: <DotsIcon />, text: <>Tap the <b>three dots</b> at the top right.</> },
        { icon: <AddIcon />, text: <>Tap <b>Add to Home screen</b> or <b>Install app</b>.</> },
        { text: <>Tap <b>Install</b> or <b>Add</b>.</> }
      ]
    };
    case "in-app": return {
      title: "First, open this in your browser", arrow: "top-right", steps: [
        { icon: <DotsRowIcon />, text: <>Tap the <b>•••</b> or <b>share</b> button at the top of this screen.</> },
        { text: <>Tap <b>Open in Safari</b> or <b>Open in Chrome</b>. <small>Or use the Copy link button below and paste it into your browser.</small></> },
        { text: <>The steps to add Bussin will show up there.</> }
      ]
    };
    default: return { title: "Add Bussin to your phone", arrow: null, steps: [
      { text: <>Open this page on your phone, in Safari (iPhone) or Chrome (Android).</> }
    ] };
  }
}

/**
 * The full guide. `who` changes one line of wording; `onDone` is "Skip" or "I did it".
 */
export function InstallGuide({ who, onDone, signedIn }: { who: Who; onDone: () => void; signedIn?: boolean }) {
  const kind = platform();
  const prompt = useInstallEvent();
  const [step, setStep] = useState(0);
  const [copied, setCopied] = useState(false);
  const [finished, setFinished] = useState(false);
  const plan = planFor(kind);
  const why = who === "parent" ? "See your bus and get alerts with one tap, like any other app."
    : who === "counselor" ? "Open your bus with one tap every morning, like any other app."
      : "Open Bussin with one tap, like any other app.";

  async function nativeInstall() {
    if (!prompt) return;
    await prompt.prompt();
    const choice = await prompt.userChoice.catch(() => ({ outcome: "dismissed" as const }));
    if (choice.outcome === "accepted") setFinished(true);
  }
  async function copyLink() {
    try { await navigator.clipboard.writeText(location.href); setCopied(true); } catch { setCopied(false); }
  }

  if (finished) return <div className="ig">
    <div className="ig-card">
      <img className="ig-app" src="/icon-192.png" alt="" />
      <h1>Done. Now open Bussin from your home screen.</h1>
      <p className="ig-why">Look for this icon. {kind.startsWith("ios") && !signedIn ? "You'll sign in there." : kind.startsWith("ios") ? "You'll sign in once more there." : "You can close this page."}</p>
      <button type="button" className="ig-later" onClick={onDone}>Keep using this page</button>
    </div>
  </div>;

  const last = step >= plan.steps.length - 1;
  return <div className="ig" role="dialog" aria-modal="true" aria-label="Add Bussin to your home screen">
    <div className="ig-card">
      <img className="ig-app" src="/icon-192.png" alt="" />
      <p className="ig-eyebrow">{signedIn ? "ONE-TIME SETUP" : "BEFORE YOU SIGN IN"}</p>
      <h1>Put Bussin on your home screen</h1>
      <p className="ig-why">{why}</p>

      {kind === "android-chrome" && prompt ? <>
        <button type="button" className="ig-go" onClick={() => void nativeInstall()}>Add Bussin to my home screen</button>
        <p className="ig-small">Then tap <b>Install</b> in the box that pops up.</p>
      </> : <>
        <h2>{plan.title}</h2>
        <ol className="ig-steps">{plan.steps.map((item, index) => <li key={index} className={index === step ? "on" : index < step ? "done" : ""}
          aria-current={index === step ? "step" : undefined}>
          <span className="ig-n">{index < step ? "✓" : index + 1}</span>
          <span className="ig-text">{item.text}</span>
          {item.icon && <span className="ig-icon">{item.icon}</span>}
        </li>)}</ol>
        {kind === "in-app" && <button type="button" className="ig-copy" onClick={() => void copyLink()}>{copied ? "Link copied" : "Copy link"}</button>}
        {plan.steps.length > 1 && <div className="ig-nav">
          {step > 0 && <button type="button" className="ig-back" onClick={() => setStep(step - 1)}>Back</button>}
          <button type="button" className="ig-go" onClick={() => last ? (kind === "in-app" ? undefined : setFinished(true)) : setStep(step + 1)}
            disabled={last && kind === "in-app"}>{last ? (kind === "in-app" ? "Waiting for your browser" : "I did it") : `Done with step ${step + 1}`}</button>
        </div>}
      </>}
      <button type="button" className="ig-later" onClick={() => { rememberSkip(); onDone(); }}>Skip for now</button>
    </div>
    {plan.arrow && !(kind === "android-chrome" && prompt) && step === 0 && <div className={`ig-arrow ${plan.arrow}`} aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="M12 3v16M5 12l7 7 7-7" /></svg></div>}
  </div>;
}

/** Before the login screen on a phone: install first, because an iPhone app signs in separately. */
export function InstallFirst({ who, children }: { who: Who; children: ReactNode }) {
  const [show, setShow] = useState(() => isPhone() && !isInstalled() && !skippedRecently());
  return show ? <InstallGuide who={who} onDone={() => setShow(false)} /> : <>{children}</>;
}

/** For people already signed in: a strip that opens the guide. Gone once it's on the home screen. */
export function InstallBanner({ who }: { who: Who }) {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(() => !isPhone() || isInstalled());
  if (hidden) return null;
  return <>
    <button type="button" className="ig-banner" onClick={() => setOpen(true)}>
      <img src="/icon-192.png" alt="" />
      <span><b>Add Bussin to your home screen</b><small>3 taps. We&rsquo;ll show you which ones.</small></span>
      <i aria-hidden="true">›</i>
    </button>
    {open && <InstallGuide who={who} signedIn onDone={() => { setOpen(false); if (isInstalled()) setHidden(true); }} />}
  </>;
}
