// The message thread: bubbles, time separators, Delivered/Read receipts, typing dots, saved conversation.
const TIME_GAP_MS = 15 * 60 * 1000;        // show a time separator after 15 quiet minutes
const SAVE_KEY = "evan.thread.v1";
const MAX_SAVED = 200;

const timeLabel = (at) => {
  const d = new Date(at);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay ? `Today ${time}` : `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${time}`;
};

/**
 * @param {HTMLElement} log the scrolling message container
 * @returns thread API
 */
export function createThread(log) {
  let lastAt = 0;
  const receipt = document.createElement("div");
  receipt.className = "receipt";

  const scroll = () => { log.scrollTop = log.scrollHeight; };

  function separatorIfNeeded(at) {
    if (at - lastAt > TIME_GAP_MS) {
      const sep = document.createElement("div");
      sep.className = "time-sep";
      sep.textContent = timeLabel(at);
      log.appendChild(sep);
    }
    lastAt = at;
  }

  function bubble(cls, text, at = Date.now()) {
    if (cls !== "error") separatorIfNeeded(at);
    const div = document.createElement("div");
    div.className = `msg ${cls}`;
    div.textContent = text;
    log.appendChild(div);
    if (cls === "me") setReceipt("Delivered", div);
    else if (receipt.isConnected && cls === "them") receipt.remove();
    scroll();
    return div;
  }

  /** Receipt sits under your latest message, like iMessage. */
  function setReceipt(text, afterEl) {
    receipt.textContent = text;
    const target = afterEl || [...log.querySelectorAll(".msg.me")].pop();
    if (target) target.after(receipt);
  }

  function typing(isTyping) {
    const existing = log.querySelector(".typing-dots");
    if (isTyping && !existing) {
      const dots = document.createElement("div");
      dots.className = "typing-dots";
      dots.innerHTML = "<i></i><i></i><i></i>";
      log.appendChild(dots);
      scroll();
    } else if (!isTyping && existing) {
      existing.remove();
    }
  }

  return {
    bubble,
    typing,
    markRead: () => setReceipt(`Read ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`),
    note(text) {
      const div = document.createElement("div");
      div.className = "intro";
      div.textContent = text;
      log.appendChild(div);
    },
    clear() {
      log.replaceChildren();
      lastAt = 0;
    },
  };
}

/** Saved conversation in this browser only: [{ who: "You" | "Evan", text, at }]. */
export function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((m) => (m.who === "You" || m.who === "Evan") && typeof m.text === "string") : [];
  } catch {
    return [];
  }
}

export function save(history) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(history.slice(-MAX_SAVED))); } catch { /* best effort */ }
}

export function forget() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* best effort */ }
}
