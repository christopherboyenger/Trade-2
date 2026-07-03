// Jarvis dashboard frontend — polls the portfolio API and drives the chat.
const fmtUsd = (n) =>
  n == null || Number.isNaN(n)
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const fmtNum = (n) => (n == null || Number.isNaN(n) ? "—" : Number(n).toLocaleString("en-US"));
const signed = (n) => (n == null ? "" : n >= 0 ? "pos" : "neg");

async function refreshPortfolio() {
  let snap;
  try {
    const res = await fetch("/api/portfolio");
    snap = await res.json();
  } catch {
    return;
  }
  if (!snap || snap.error) return;

  // Header badge
  const modeBadge = document.getElementById("mode-badge");
  modeBadge.textContent = snap.mode === "live" ? "LIVE" : "PAPER";
  modeBadge.className = "badge " + (snap.mode === "live" ? "live" : "paper");

  document.getElementById("total-equity").textContent = fmtUsd(snap.totalEquity);
  const pnlEl = document.getElementById("total-pnl");
  pnlEl.textContent = (snap.totalUnrealizedPnl >= 0 ? "+" : "") + fmtUsd(snap.totalUnrealizedPnl) + " unrealized";
  pnlEl.className = "pnl " + signed(snap.totalUnrealizedPnl);
  document.getElementById("as-of").textContent = "as of " + new Date(snap.asOf).toLocaleTimeString();

  // Venue cards
  const venuesEl = document.getElementById("venues");
  venuesEl.innerHTML = "";
  for (const v of snap.venues) {
    const dot = !v.configured ? "off" : v.connected ? "ok" : "err";
    const div = document.createElement("div");
    div.className = "venue";
    div.innerHTML =
      `<div class="name">${v.venue}<span class="dot ${dot}"></span></div>` +
      `<div class="cls">${v.assetClass} · ${v.mode}</div>` +
      `<div class="eq">${v.balance ? fmtUsd(v.balance.equity) : (v.configured ? "—" : "not connected")}</div>` +
      (v.error ? `<div class="err">${v.error}</div>` : "");
    venuesEl.appendChild(div);
  }

  // Positions table
  const tbody = document.querySelector("#positions tbody");
  const rows = snap.venues.flatMap((v) => v.positions);
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">No open positions.</td></tr>`;
  } else {
    tbody.innerHTML = rows
      .map(
        (p) =>
          `<tr><td>${p.venue}</td><td>${p.symbol}</td><td>${fmtNum(p.quantity)}</td>` +
          `<td>${fmtUsd(p.avgPrice)}</td><td>${fmtUsd(p.markPrice)}</td>` +
          `<td>${fmtUsd(p.marketValue)}</td>` +
          `<td class="${signed(p.unrealizedPnl)}">${fmtUsd(p.unrealizedPnl)}</td></tr>`,
      )
      .join("");
  }
}

async function loadHealth() {
  try {
    const res = await fetch("/api/health");
    const h = await res.json();
    const b = document.getElementById("brain-badge");
    b.textContent = "brain: " + (h.jarvis ? "on" : "off");
    b.className = "badge " + (h.jarvis ? "" : "muted");
  } catch {}
}

// ---- Chat ----
const history = [];
const chatEl = document.getElementById("chat");
const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");

function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  addMsg("user", text);
  history.push({ role: "user", content: text });

  const btn = form.querySelector("button");
  btn.disabled = true;
  const thinking = addMsg("assistant", "…");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ history }),
    });
    const data = await res.json();
    if (!res.ok) {
      thinking.className = "msg error";
      thinking.textContent = data.error ?? "Chat error";
    } else {
      thinking.textContent = data.reply;
      history.push({ role: "assistant", content: data.reply });
      refreshPortfolio(); // a trade may have changed holdings
    }
  } catch (err) {
    thinking.className = "msg error";
    thinking.textContent = String(err);
  } finally {
    btn.disabled = false;
    input.focus();
  }
});

loadHealth();
refreshPortfolio();
setInterval(refreshPortfolio, 10_000);
