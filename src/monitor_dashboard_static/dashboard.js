(() => {
  const qs = new URLSearchParams(window.location.search);
  const state = {
    bots: new Map(),
    focusedBotKey: null,
    focusSymbols: new Map(),
    ws: null,
    reconnectTimer: null,
    snapshotTimer: null,
    lastWsTs: null,
  };
  const BOT_MISSING_PRUNE_MS = 30000;

  const els = {
    heroTitle: document.getElementById("hero-title"),
    heroSubtitle: document.getElementById("hero-subtitle"),
    focusSelect: document.getElementById("focus-symbol"),
    refreshButton: document.getElementById("refresh-button"),
    wsStatus: document.getElementById("ws-status"),
    snapshotStatus: document.getElementById("snapshot-status"),
    focusStatus: document.getElementById("focus-status"),
    relayStatus: document.getElementById("relay-status"),
    botsMeta: document.getElementById("bots-meta"),
    botOverview: document.getElementById("bot-overview"),
    summaryMeta: document.getElementById("summary-meta"),
    summaryCards: document.getElementById("summary-cards"),
    focusLabel: document.getElementById("focus-label"),
    focusDetails: document.getElementById("focus-details"),
    positionsMeta: document.getElementById("positions-meta"),
    positionsBody: document.getElementById("positions-body"),
    trailingList: document.getElementById("trailing-list"),
    foragerDetails: document.getElementById("forager-details"),
    unstuckDetails: document.getElementById("unstuck-details"),
    eventsList: document.getElementById("events-list"),
    ticksList: document.getElementById("ticks-list"),
    ordersList: document.getElementById("orders-list"),
    emptyTemplate: document.getElementById("empty-state-template"),
    sidebarBotList: document.getElementById("sidebar-bot-list"),
  };

  function fmtCompact(value, digits = 4) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
    const text = Number(value).toFixed(digits).replace(/\.?0+$/, "");
    return text === "-0" ? "0" : text;
  }

  function fmtPctRatio(value, digits = 2) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
    const pct = Number(value) * 100;
    const sign = pct >= 0 ? "+" : "";
    return `${sign}${pct.toFixed(digits)}%`;
  }

  function fmtAgeMs(tsMs) {
    if (!tsMs) return "-";
    const delta = Math.max(0, Date.now() - Number(tsMs));
    if (delta < 1000) return `${Math.round(delta)}ms`;
    const s = delta / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = s / 60;
    if (m < 60) return `${m.toFixed(1)}m`;
    return `${(m / 60).toFixed(1)}h`;
  }

  function fmtUptimeMs(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
    let seconds = Math.max(0, Math.floor(Number(value) / 1000));
    const hours = Math.floor(seconds / 3600);
    seconds -= hours * 3600;
    const minutes = Math.floor(seconds / 60);
    seconds -= minutes * 60;
    if (hours) return `${hours}h${String(minutes).padStart(2, "0")}m${String(seconds).padStart(2, "0")}s`;
    if (minutes) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
    return `${seconds}s`;
  }

  function fmtTs(tsMs) {
    if (!tsMs) return "-";
    try {
      return new Date(Number(tsMs)).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
    } catch {
      return String(tsMs);
    }
  }

  function fmtShortTs(tsMs) {
    if (!tsMs) return "-";
    try {
      return new Date(Number(tsMs)).toISOString().slice(11, 19) + "Z";
    } catch {
      return String(tsMs);
    }
  }

  function escapeHtml(text) {
    return String(text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function shortSymbol(symbol) {
    if (!symbol) return "-";
    return String(symbol).replace(":USDT", "").replace(":USDC", "");
  }

  function compactEntries(entries) {
    return entries.filter(([, value]) => value !== null && value !== undefined && value !== "-" && value !== "");
  }

  function summarizeObject(payload, limit = 3) {
    if (!payload || typeof payload !== "object") return "-";
    const parts = Object.entries(payload)
      .filter(([, value]) => typeof value !== "object")
      .slice(0, limit)
      .map(([key, value]) => {
        const formatted = typeof value === "number" ? fmtCompact(value, 4) : String(value);
        return `${key}=${formatted}`;
      });
    return parts.length ? parts.join(" · ") : "-";
  }

  function rankingLabel(entry) {
    if (!entry || !entry.symbol) return "-";
    return `${shortSymbol(entry.symbol)} ${fmtCompact(entry.total_score ?? entry.normalized_score, 2)}`;
  }

  function focusClasses(symbol, focusSymbol, baseClass = "") {
    const classes = [];
    if (baseClass) classes.push(baseClass);
    if (symbol) classes.push("is-clickable");
    if (symbol && focusSymbol && symbol === focusSymbol) classes.push("is-focus");
    return classes.join(" ");
  }

  function emptyNode() {
    return els.emptyTemplate.content.firstElementChild.cloneNode(true);
  }

  function setChip(el, text, tone = "") {
    el.textContent = text;
    el.classList.remove("is-ok", "is-warn", "is-bad");
    if (tone) el.classList.add(tone);
  }

  function botKey(exchange, user) {
    if (!exchange || !user) return null;
    return `${exchange}/${user}`;
  }

  function splitBotKey(key) {
    if (!key) return [null, null];
    const slash = key.indexOf("/");
    if (slash === -1) return [key, null];
    return [key.slice(0, slash), key.slice(slash + 1)];
  }

  function messageKey(message) {
    if (!message) return null;
    if (message.exchange && message.user) return botKey(message.exchange, message.user);
    const payload = message.payload || {};
    const meta = payload.meta || {};
    return botKey(meta.exchange, meta.user);
  }

  function preferredBotKeyFromQs() {
    return botKey(qs.get("exchange"), qs.get("user"));
  }

  function ensureBotState(key) {
    if (!state.bots.has(key)) {
      state.bots.set(key, {
        snapshot: null,
        recentEvents: [],
        recentTicks: new Map(),
        lastMessageTs: 0,
        firstSeenAtMs: Date.now(),
        missingSinceMs: null,
      });
    }
    return state.bots.get(key);
  }

  function sortedBotEntries() {
    return Array.from(state.bots.entries())
      .filter(([, entry]) => entry.snapshot && entry.snapshot.payload)
      .sort((a, b) => {
        if (a[0] === state.focusedBotKey) return -1;
        if (b[0] === state.focusedBotKey) return 1;
        const fa = Number(a[1].firstSeenAtMs || 0);
        const fb = Number(b[1].firstSeenAtMs || 0);
        if (fa !== fb) return fa - fb;
        return a[0].localeCompare(b[0]);
      });
  }

  function ensureFocusedBotKey() {
    if (state.focusedBotKey && state.bots.has(state.focusedBotKey)) return state.focusedBotKey;
    const preferred = preferredBotKeyFromQs();
    if (preferred && state.bots.has(preferred)) {
      state.focusedBotKey = preferred;
      return preferred;
    }
    const first = sortedBotEntries()[0];
    state.focusedBotKey = first ? first[0] : null;
    return state.focusedBotKey;
  }

  function setFocusedBotKey(key) {
    state.focusedBotKey = key || null;
    if (state.focusedBotKey) {
      const [exchange, user] = splitBotKey(state.focusedBotKey);
      qs.set("exchange", exchange || "");
      qs.set("user", user || "");
    } else {
      qs.delete("exchange");
      qs.delete("user");
    }
    render();
  }

  function focusSymbolForKey(key) {
    if (!key) return "";
    if (state.focusSymbols.has(key)) return state.focusSymbols.get(key) || "";
    const preferred = preferredBotKeyFromQs();
    if (preferred && key === preferred) {
      return qs.get("symbol") || "";
    }
    return "";
  }

  function setFocusSymbol(symbol) {
    const key = ensureFocusedBotKey();
    if (!key) return;
    if (symbol) {
      state.focusSymbols.set(key, symbol);
      qs.set("symbol", symbol);
    } else {
      state.focusSymbols.delete(key);
      qs.delete("symbol");
    }
    render();
  }

  function currentBotEntry() {
    const key = ensureFocusedBotKey();
    return key ? state.bots.get(key) || null : null;
  }

  function currentSnapshot() {
    return currentBotEntry()?.snapshot || null;
  }

  function currentPayload() {
    return currentSnapshot()?.payload || null;
  }

  function normalizeSnapshotMessages(payload) {
    if (payload?.type === "snapshot_bundle" && Array.isArray(payload.bots)) return payload.bots;
    if (payload?.type === "snapshot") return [payload];
    return [];
  }

  function ingestSnapshotPayload(payload) {
    const messages = normalizeSnapshotMessages(payload);
    const seenKeys = new Set();
    const nowMs = Date.now();
    for (const message of messages) {
      const key = messageKey(message);
      if (!key) continue;
      seenKeys.add(key);
      const bot = ensureBotState(key);
      bot.snapshot = message;
      bot.lastMessageTs = Number(message.ts || Date.now());
      bot.missingSinceMs = null;
    }
    if (messages.length) {
      for (const key of Array.from(state.bots.keys())) {
        if (!seenKeys.has(key)) {
          const bot = state.bots.get(key);
          if (!bot) continue;
          if (bot.missingSinceMs === null) bot.missingSinceMs = nowMs;
          if (nowMs - Number(bot.missingSinceMs || nowMs) >= BOT_MISSING_PRUNE_MS) {
            state.bots.delete(key);
            state.focusSymbols.delete(key);
          }
        }
      }
    }
    ensureFocusedBotKey();
  }

  function pushEvent(message) {
    const key = messageKey(message);
    if (!key) return;
    const bot = ensureBotState(key);
    bot.recentEvents = [
      message,
      ...bot.recentEvents.filter(
        (entry) =>
          !(entry.kind === message.kind && entry.ts === message.ts && entry.symbol === message.symbol)
      ),
    ].slice(0, 60);
    bot.lastMessageTs = Number(message.ts || Date.now());
  }

  function pushTick(message) {
    const key = messageKey(message);
    if (!key || !message.symbol) return;
    const bot = ensureBotState(key);
    bot.recentTicks.set(message.symbol, message);
    const sorted = Array.from(bot.recentTicks.entries())
      .sort((a, b) => Number(b[1].ts || 0) - Number(a[1].ts || 0))
      .slice(0, 60);
    bot.recentTicks = new Map(sorted);
    bot.lastMessageTs = Number(message.ts || Date.now());
  }

  function availableSymbols(payload) {
    if (!payload || !payload.market) return [];
    return Object.keys(payload.market).sort();
  }

  function activePositionRows(payload) {
    if (!payload || !payload.positions) return [];
    const rows = [];
    const openOrders = payload.open_orders || {};
    for (const [symbol, position] of Object.entries(payload.positions)) {
      for (const pside of ["long", "short"]) {
        const side = position && typeof position === "object" ? position[pside] : null;
        if (!side || !Number(side.size)) continue;
        rows.push({
          symbol,
          pside,
          side,
          orderCount: Array.isArray(openOrders[symbol])
            ? openOrders[symbol].filter((order) => order.position_side === pside).length
            : 0,
        });
      }
    }
    rows.sort(
      (a, b) => Math.abs(Number(b.side.wallet_exposure || 0)) - Math.abs(Number(a.side.wallet_exposure || 0))
    );
    return rows;
  }

  function selectedFocusSymbol(botKeyValue, payload) {
    const explicit = focusSymbolForKey(botKeyValue);
    const symbols = availableSymbols(payload);
    if (explicit && symbols.includes(explicit)) return explicit;
    const rows = activePositionRows(payload);
    if (rows.length) return rows[0].symbol;
    return symbols[0] || "";
  }

  function filteredTrailingRows(payload, focusSymbol) {
    const trailing = payload && payload.trailing ? payload.trailing : {};
    const rows = [];
    for (const [symbol, sides] of Object.entries(trailing || {})) {
      for (const pside of ["long", "short"]) {
        const side = sides && sides[pside];
        if (!side || typeof side !== "object") continue;
        for (const kind of ["entry", "close"]) {
          if (side[kind]) rows.push({ symbol, pside, kind, payload: side[kind] });
        }
      }
    }
    rows.sort((a, b) => {
      const focusBoost = (a.symbol === focusSymbol ? -1 : 0) - (b.symbol === focusSymbol ? -1 : 0);
      if (focusBoost !== 0) return focusBoost;
      return a.symbol.localeCompare(b.symbol) || a.kind.localeCompare(b.kind);
    });
    return rows;
  }

  function filteredEvents(botEntry, focusSymbol) {
    const events = [...(botEntry?.recentEvents || [])];
    const focused = focusSymbol ? events.filter((event) => event.symbol === focusSymbol) : [];
    const others = focusSymbol ? events.filter((event) => event.symbol !== focusSymbol) : events;
    const ordered = [...focused, ...others];
    const nonBalance = ordered.filter((event) => event.kind !== "account.balance");
    const balance = ordered.find((event) => event.kind === "account.balance");
    const result = nonBalance.slice(0, 7);
    if (balance) result.push(balance);
    return result.slice(0, 8);
  }

  function filteredTicks(botEntry, focusSymbol) {
    const items = Array.from((botEntry?.recentTicks || new Map()).entries()).sort(
      (a, b) => Number(b[1].ts || 0) - Number(a[1].ts || 0)
    );
    if (!focusSymbol) return items.slice(0, 8);
    const focused = items.filter(([symbol]) => symbol === focusSymbol);
    const others = items.filter(([symbol]) => symbol !== focusSymbol);
    return [...focused, ...others].slice(0, 8);
  }

  function recentOrders(payload, focusSymbol) {
    const recent = payload && payload.recent ? payload.recent : {};
    const merged = [];
    for (const [key, action] of [["order_executions", "executed"], ["order_cancellations", "canceled"]]) {
      const rows = Array.isArray(recent[key]) ? recent[key] : [];
      for (const entry of rows) merged.push({ ...entry, action });
    }
    merged.sort((a, b) => Number(b.execution_timestamp || 0) - Number(a.execution_timestamp || 0));
    const filtered = focusSymbol
      ? merged.filter((entry) => entry.symbol === focusSymbol).concat(merged.filter((entry) => entry.symbol !== focusSymbol))
      : merged;
    return filtered.slice(0, 8);
  }

  function summarizeEvent(event) {
    const payload = event.payload || {};
    switch (event.kind) {
      case "account.balance":
        return compactEntries([
          ["eq", fmtCompact(payload.equity, 2)],
          ["bal", fmtCompact(payload.balance_raw ?? payload.balance_snapped, 2)],
        ])
          .map(([key, value]) => `${key} ${value}`)
          .join(" · ");
      case "position.changed":
        return compactEntries([
          ["size", fmtCompact(payload.new_size ?? payload.size, 4)],
          ["price", fmtCompact(payload.new_price ?? payload.price, 4)],
          ["upnl", fmtCompact(payload.upnl, 2)],
        ])
          .map(([key, value]) => `${key} ${value}`)
          .join(" · ");
      case "order.executed":
      case "order.canceled":
        return compactEntries([
          ["qty", fmtCompact(payload.qty, 4)],
          ["px", fmtCompact(payload.price, 4)],
          ["type", payload.pb_order_type],
        ])
          .map(([key, value]) => `${key} ${value}`)
          .join(" · ");
      case "hsl.transition":
        return compactEntries([
          ["tier", payload.tier],
          ["score", fmtCompact(payload.drawdown_score, 4)],
          ["halted", payload.halted],
        ])
          .map(([key, value]) => `${key} ${value}`)
          .join(" · ");
      case "health.summary":
        return compactEntries([
          ["loop", `${fmtCompact(payload.last_loop_duration_ms, 0)}ms`],
          ["fills", fmtCompact(payload.fills, 0)],
          ["orders", fmtCompact(payload.orders_placed, 0)],
        ])
          .map(([key, value]) => `${key} ${value}`)
          .join(" · ");
      default:
        return summarizeObject(payload, 4);
    }
  }

  function trailingStatusTone(status) {
    if (status === "triggered") return "is-ok";
    if (status === "waiting_threshold" || status === "waiting_retracement") return "is-warn";
    return "";
  }

  function positionCounts(payload) {
    let longCount = 0;
    let shortCount = 0;
    const positions = payload?.positions || {};
    for (const position of Object.values(positions)) {
      const longPos = position?.long || {};
      const shortPos = position?.short || {};
      if (Number(longPos.size || 0)) longCount += 1;
      if (Number(shortPos.size || 0)) shortCount += 1;
    }
    return { longCount, shortCount };
  }

  function botDisplayLabel(key) {
    const [exchange, user] = splitBotKey(key);
    return `${exchange || "-"} / ${user || "-"}`;
  }

  function botMode(exchange, user) {
    if ((exchange || "").toLowerCase() === "fake") return "paper";
    const combined = `${exchange || ""} ${user || ""}`.toLowerCase();
    if (combined.includes("testnet") || combined.includes("sandbox")) return "testnet";
    return "live";
  }

  function botModePillHtml(exchange, user) {
    const mode = botMode(exchange, user);
    const cls = mode === "paper" ? "is-paper" : mode === "testnet" ? "is-testnet" : "is-live";
    return `<span class="pill ${cls}">${mode}</span>`;
  }

  function botRelayStatus(botEntry) {
    return botEntry?.snapshot?.relay?.status || "active";
  }

  function botStatusTone(status) {
    if (status === "active") return "is-ok";
    if (status === "stale") return "is-warn";
    return "";
  }

  function renderBotOverview(botEntries) {
    els.botOverview.innerHTML = "";
    const activeCount = botEntries.filter(([, entry]) => botRelayStatus(entry) === "active").length;
    const staleCount = botEntries.filter(([, entry]) => botRelayStatus(entry) === "stale").length;
    const metaParts = [`${botEntries.length} ${botEntries.length === 1 ? "bot" : "bots"} visible`];
    metaParts.push(`${activeCount} active`);
    if (staleCount) metaParts.push(`${staleCount} stale`);
    els.botsMeta.textContent = metaParts.join(" · ");
    if (!botEntries.length) {
      els.botOverview.appendChild(emptyNode());
      return;
    }
    for (const [key, botEntry] of botEntries) {
      const payload = botEntry.snapshot?.payload || {};
      const account = payload.account || {};
      const health = payload.health || {};
      const hsl = payload.hsl || {};
      const counts = positionCounts(payload);
      const relay = botEntry.snapshot?.relay || {};
      const presence = relay.status || "active";
      const card = document.createElement("article");
      card.className = focusClasses(key, state.focusedBotKey, "overview-card");
      card.dataset.botKey = key;
      const [cardExch, cardUser] = splitBotKey(key);
      const isManaged = perBotCtrl.managedKeys.has(key);
      const ctrlBtnHtml = isManaged
        ? `<button class="bot-card-ctrl" data-state="loading" data-bot-key="${escapeHtml(key)}">…</button>`
        : "";
      card.innerHTML = `
        <div class="overview-head">
          <div>
            <p class="overview-title">${escapeHtml(botDisplayLabel(key))} ${botModePillHtml(cardExch, cardUser)}</p>
            <p class="overview-subtitle">snapshot ${escapeHtml(fmtAgeMs(botEntry.snapshot?.ts))} · ${escapeHtml(fmtTs(botEntry.snapshot?.ts))} · seen ${escapeHtml(fmtAgeMs(relay.last_activity_ts_ms))}</p>
          </div>
          <div class="overview-head-right">
            <span class="pill ${key === state.focusedBotKey ? "is-ok" : botStatusTone(presence)}">${escapeHtml(key === state.focusedBotKey ? `focused · ${presence}` : presence)}</span>
            ${ctrlBtnHtml}
          </div>
        </div>
        <div class="overview-metrics">
          <div class="overview-metric">
            <p class="label">Equity</p>
            <p class="value">${escapeHtml(fmtCompact(account.equity, 2))}</p>
          </div>
          <div class="overview-metric">
            <p class="label">Loop</p>
            <p class="value">${escapeHtml(`${fmtCompact(health.last_loop_duration_ms, 0)} ms`)}</p>
          </div>
          <div class="overview-metric">
            <p class="label">Positions</p>
            <p class="value">${escapeHtml(`L ${counts.longCount} / S ${counts.shortCount}`)}</p>
          </div>
          <div class="overview-metric">
            <p class="label">HSL</p>
            <p class="value">${escapeHtml(`L ${hsl.long?.tier || "-"} / S ${hsl.short?.tier || "-"}`)}</p>
          </div>
        </div>
        <p class="overview-foot">events ${escapeHtml(String(botEntry.recentEvents.length))} · ticks ${escapeHtml(String(botEntry.recentTicks.size))} · uptime ${escapeHtml(fmtUptimeMs(health.uptime_ms))}</p>
      `;
      els.botOverview.appendChild(card);
      if (isManaged) {
        const btn = card.querySelector(".bot-card-ctrl");
        if (btn) {
          updateBotCardCtrlBtn(key);
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            handleBotCardCtrlClick(key);
          });
        }
      }
    }
  }

  function buildSummaryCards(payload) {
    const account = payload.account || {};
    const health = payload.health || {};
    const hsl = payload.hsl || {};
    const rows = [
      ["Equity", fmtCompact(account.equity, 2)],
      ["Balance", fmtCompact(account.balance_raw, 2)],
      ["Realized", fmtCompact(account.realized_pnl_cumsum && account.realized_pnl_cumsum.current, 2)],
      ["Loop", `${fmtCompact(health.last_loop_duration_ms, 0)} ms`],
      ["Orders", `${fmtCompact(health.orders_placed, 0)} / ${fmtCompact(health.orders_cancelled, 0)}`],
      ["Fills", fmtCompact(health.fills, 0)],
      ["Uptime", fmtUptimeMs(health.uptime_ms)],
      ["HSL", `L ${hsl.long?.tier || "-"} / S ${hsl.short?.tier || "-"}`],
    ];
    els.summaryCards.innerHTML = "";
    for (const [label, value] of rows) {
      const card = document.createElement("article");
      card.className = "stat-card";
      card.innerHTML = `<p class="label">${escapeHtml(label)}</p><p class="value">${escapeHtml(value)}</p>`;
      els.summaryCards.appendChild(card);
    }
  }

  function renderFocus(payload, focusSymbol) {
    els.focusLabel.textContent = focusSymbol || "auto";
    els.focusDetails.innerHTML = "";
    if (!focusSymbol || !payload.market || !payload.market[focusSymbol]) {
      els.focusDetails.appendChild(emptyNode());
      return;
    }
    const market = payload.market[focusSymbol] || {};
    const position = payload.positions?.[focusSymbol] || {};
    const long = position.long || {};
    const short = position.short || {};
    const detailRows = [
      ["Last", `${fmtCompact(market.last_price)} (${fmtAgeMs(market.last_price_ts_ms)})`],
      ["Tradable", `${market.tradable} | active=${market.active_symbol}`],
      ["Long", `${fmtCompact(long.size)} @ ${fmtCompact(long.price)} | WE ${fmtCompact(long.wallet_exposure)} | uPnL ${fmtCompact(long.upnl, 2)}`],
      ["Short", `${fmtCompact(short.size)} @ ${fmtCompact(short.price)} | WE ${fmtCompact(short.wallet_exposure)} | uPnL ${fmtCompact(short.upnl, 2)}`],
      ["EMA", `lo ${fmtCompact(market.ema_bands?.long?.lower)} | hi ${fmtCompact(market.ema_bands?.long?.upper)}`],
      ["Approvals", `L ${market.approved?.long} / S ${market.approved?.short} | ignored L ${market.ignored?.long} / S ${market.ignored?.short}`],
    ];
    for (const [label, value] of detailRows) {
      const row = document.createElement("div");
      row.className = "detail-row";
      row.innerHTML = `<p class="headline"><span>${escapeHtml(label)}</span></p><p class="subline">${escapeHtml(value)}</p>`;
      els.focusDetails.appendChild(row);
    }
  }

  function renderPositions(payload, focusSymbol) {
    const rows = activePositionRows(payload);
    const totalLong = rows
      .filter((row) => row.pside === "long")
      .reduce((acc, row) => acc + Number(row.side.wallet_exposure || 0), 0);
    const totalShort = rows
      .filter((row) => row.pside === "short")
      .reduce((acc, row) => acc + Number(row.side.wallet_exposure || 0), 0);
    const twelLong = rows.find((row) => row.pside === "long")?.side.total_wallet_exposure_limit || 0;
    const twelShort = rows.find((row) => row.pside === "short")?.side.total_wallet_exposure_limit || 0;
    els.positionsMeta.textContent = `TWE L ${fmtCompact(totalLong)}/${fmtCompact(twelLong)} | S ${fmtCompact(totalShort)}/${fmtCompact(twelShort)}`;
    els.positionsBody.innerHTML = "";
    if (!rows.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="8"><div class="empty-state">No active positions.</div></td>`;
      els.positionsBody.appendChild(tr);
      return;
    }
    rows.sort((a, b) => {
      const focusBoost = (a.symbol === focusSymbol ? -1 : 0) - (b.symbol === focusSymbol ? -1 : 0);
      if (focusBoost !== 0) return focusBoost;
      return Math.abs(Number(b.side.wallet_exposure || 0)) - Math.abs(Number(a.side.wallet_exposure || 0));
    });
    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.className = focusClasses(row.symbol, focusSymbol);
      if (row.symbol) tr.dataset.symbol = row.symbol;
      tr.innerHTML = `
        <td class="positions-symbol">${escapeHtml(shortSymbol(row.symbol))}</td>
        <td><span class="pill ${row.pside === "long" ? "is-ok" : "is-bad"}">${escapeHtml(row.pside)}</span></td>
        <td class="mono">${escapeHtml(`${fmtCompact(row.side.size)} @ ${fmtCompact(row.side.price)}`)}</td>
        <td class="mono">${escapeHtml(fmtCompact(row.side.wallet_exposure))}</td>
        <td class="mono">${escapeHtml(`${fmtPctRatio(row.side.wel_ratio)} / ${fmtPctRatio(row.side.wele_ratio)}`)}</td>
        <td class="mono">${escapeHtml(fmtPctRatio(row.side.price_action_distance))}</td>
        <td class="mono">${escapeHtml(fmtCompact(row.side.upnl, 2))}</td>
        <td class="mono">${escapeHtml(String(row.orderCount))}</td>
      `;
      els.positionsBody.appendChild(tr);
    }
  }

  function renderTrailing(payload, focusSymbol) {
    els.trailingList.innerHTML = "";
    const rows = filteredTrailingRows(payload, focusSymbol);
    if (!rows.length) {
      els.trailingList.appendChild(emptyNode());
      return;
    }
    for (const row of rows) {
      const item = document.createElement("article");
      item.className = focusClasses(row.symbol, focusSymbol, "stack-item");
      if (row.symbol) item.dataset.symbol = row.symbol;
      item.innerHTML = `
        <p class="headline">
          <span>${escapeHtml(shortSymbol(row.symbol))} · ${escapeHtml(row.pside)} ${escapeHtml(row.kind)}</span>
          <span class="pill ${trailingStatusTone(row.payload.status)}">${escapeHtml(row.payload.status)}</span>
        </p>
        <p class="subline mono">cur ${escapeHtml(fmtCompact(row.payload.current_price))} · thr ${escapeHtml(fmtCompact(row.payload.threshold_price))} · ret ${escapeHtml(fmtCompact(row.payload.retracement_price))}</p>
        <p class="minor mono">thr ${escapeHtml(row.payload.threshold_met ? "met" : "wait")} · ret ${escapeHtml(row.payload.retracement_met ? "met" : "wait")} · qty ${escapeHtml(fmtCompact(row.payload.qty))} · px ${escapeHtml(fmtCompact(row.payload.price))}</p>
        <p class="minor mono">min_open ${escapeHtml(fmtCompact(row.payload.extrema?.min_since_open))} · max_min ${escapeHtml(fmtCompact(row.payload.extrema?.max_since_min))} · max_open ${escapeHtml(fmtCompact(row.payload.extrema?.max_since_open))} · min_max ${escapeHtml(fmtCompact(row.payload.extrema?.min_since_max))}</p>
      `;
      els.trailingList.appendChild(item);
    }
  }

  function renderForager(payload) {
    const sides = payload.forager || {};
    els.foragerDetails.innerHTML = "";
    for (const pside of ["long", "short"]) {
      const side = sides[pside];
      if (!side || (!side.enabled && (!side.selected_symbols || !side.selected_symbols.length))) continue;
      const item = document.createElement("article");
      item.className = "detail-row";
      item.innerHTML = `
        <p class="headline"><span>${escapeHtml(pside)}</span><span class="pill ${side.enabled ? "is-ok" : "is-warn"}">${escapeHtml(side.enabled ? "enabled" : "off")}</span></p>
        <p class="subline">slots ${escapeHtml(String(side.slots?.current || 0))}/${escapeHtml(String(side.slots?.max || 0))} · open ${escapeHtml(String(side.slots?.open || 0))} · next ${escapeHtml(shortSymbol(side.next_symbol))}</p>
        <p class="minor">rank total ${escapeHtml(rankingLabel(side.ranking?.top_total))} · vol ${escapeHtml(rankingLabel(side.ranking?.top_volume))} · vola ${escapeHtml(rankingLabel(side.ranking?.top_volatility))} · ema ${escapeHtml(rankingLabel(side.ranking?.top_ema_readiness))}</p>
      `;
      els.foragerDetails.appendChild(item);
    }
    if (!els.foragerDetails.children.length) els.foragerDetails.appendChild(emptyNode());
  }

  function renderUnstuck(payload) {
    const unstuck = payload.unstuck || {};
    els.unstuckDetails.innerHTML = "";
    for (const pside of ["long", "short"]) {
      const side = unstuck.sides?.[pside];
      if (!side || (side.status === "disabled" && !side.next_symbol)) continue;
      const item = document.createElement("article");
      item.className = "detail-row";
      item.innerHTML = `
        <p class="headline"><span>${escapeHtml(pside)}</span><span class="pill ${side.status === "ok" ? "is-ok" : side.status === "disabled" ? "" : "is-warn"}">${escapeHtml(side.status || "-")}</span></p>
        <p class="subline">allowance ${escapeHtml(fmtCompact(side.allowance_live, 4))} · next ${escapeHtml(side.next_symbol || "-")}</p>
        <p class="minor">target ${escapeHtml(fmtCompact(side.next_target_price))} · dist ${escapeHtml(fmtPctRatio(side.next_target_distance_ratio))} · ema ${escapeHtml(fmtPctRatio(side.next_unstuck_trigger_distance_ratio))}</p>
      `;
      els.unstuckDetails.appendChild(item);
    }
    if (!els.unstuckDetails.children.length) els.unstuckDetails.appendChild(emptyNode());
  }

  function renderEvents(botEntry, focusSymbol) {
    els.eventsList.innerHTML = "";
    const rows = filteredEvents(botEntry, focusSymbol);
    if (!rows.length) {
      els.eventsList.appendChild(emptyNode());
      return;
    }
    for (const event of rows) {
      const item = document.createElement("article");
      item.className = focusClasses(event.symbol, focusSymbol, "stack-item");
      if (event.symbol) item.dataset.symbol = event.symbol;
      item.innerHTML = `
        <p class="headline"><span>${escapeHtml(event.kind)}</span><span>${escapeHtml(fmtAgeMs(event.ts))}</span></p>
        <p class="subline">${escapeHtml(event.symbol ? shortSymbol(event.symbol) : event.pside || "-")}</p>
        <p class="minor mono">${escapeHtml(summarizeEvent(event))}</p>
      `;
      els.eventsList.appendChild(item);
    }
  }

  function renderTicks(payload, botEntry, focusSymbol) {
    els.ticksList.innerHTML = "";
    const rows = filteredTicks(botEntry, focusSymbol);
    if (!rows.length) {
      els.ticksList.appendChild(emptyNode());
      return;
    }
    for (const [symbol, tick] of rows) {
      const market = payload.market?.[symbol] || {};
      const item = document.createElement("article");
      item.className = focusClasses(symbol, focusSymbol, "stack-item");
      item.dataset.symbol = symbol;
      item.innerHTML = `
        <p class="headline"><span>${escapeHtml(shortSymbol(symbol))}</span><span>${escapeHtml(fmtAgeMs(tick.ts))}</span></p>
        <p class="subline mono">last ${escapeHtml(fmtCompact(tick.payload?.last))} · lo ${escapeHtml(fmtCompact(market.ema_bands?.long?.lower))} · hi ${escapeHtml(fmtCompact(market.ema_bands?.long?.upper))}</p>
      `;
      els.ticksList.appendChild(item);
    }
  }

  function renderOrders(payload, focusSymbol) {
    els.ordersList.innerHTML = "";
    const rows = recentOrders(payload, focusSymbol);
    if (!rows.length) {
      els.ordersList.appendChild(emptyNode());
      return;
    }
    for (const row of rows) {
      const item = document.createElement("article");
      item.className = focusClasses(row.symbol, focusSymbol, "stack-item");
      if (row.symbol) item.dataset.symbol = row.symbol;
      item.innerHTML = `
        <p class="headline"><span>${escapeHtml(row.action)} · ${escapeHtml(shortSymbol(row.symbol))}</span><span>${escapeHtml(fmtShortTs(row.execution_timestamp))}</span></p>
        <p class="subline mono">${escapeHtml(`${row.position_side || "-"} / ${row.side || "-"} / ${fmtCompact(row.qty)} @ ${fmtCompact(row.price)}`)}</p>
        <p class="minor">${escapeHtml(row.pb_order_type || row.reason || "-")}</p>
      `;
      els.ordersList.appendChild(item);
    }
  }

  function updateFocusOptions(payload, botKeyValue) {
    const symbols = availableSymbols(payload);
    const current = focusSymbolForKey(botKeyValue);
    els.focusSelect.innerHTML = `<option value="">Auto</option>${symbols
      .map((symbol) => `<option value="${escapeHtml(symbol)}">${escapeHtml(symbol)}</option>`)
      .join("")}`;
    els.focusSelect.value = current && symbols.includes(current) ? current : "";
  }

  function renderSidebarBots(botEntries) {
    if (!els.sidebarBotList) return;
    els.sidebarBotList.innerHTML = "";
    for (const [key, botEntry] of botEntries) {
      const payload = botEntry.snapshot?.payload || {};
      const account = payload.account || {};
      const btn = document.createElement("button");
      btn.className = `sidebar-bot-item${key === state.focusedBotKey ? " is-focused" : ""}`;
      btn.dataset.botKey = key;
      const [exchange, user] = splitBotKey(key);
      btn.innerHTML = `<span class="sidebar-bot-name">${escapeHtml(user || key)} ${botModePillHtml(exchange, user)}</span><span class="sidebar-bot-sub">${escapeHtml(exchange || "")} · ${escapeHtml(fmtCompact(account.equity, 2))}</span>`;
      els.sidebarBotList.appendChild(btn);
    }
  }

  function renderNoBots() {
    els.heroTitle.textContent = "Waiting for active bots...";
    els.heroSubtitle.textContent = "The relay is up, but no visible monitor snapshots are available yet.";
    els.botsMeta.textContent = "0 bots visible";
    els.summaryMeta.textContent = "-";
    setChip(els.snapshotStatus, "Snapshot: waiting", "is-warn");
    setChip(els.focusStatus, "Focus: none", "");
    setChip(els.relayStatus, `Relay: ${window.location.origin}`, "");
    els.botOverview.innerHTML = "";
    els.botOverview.appendChild(emptyNode());
    for (const container of [
      els.summaryCards,
      els.focusDetails,
      els.foragerDetails,
      els.unstuckDetails,
      els.eventsList,
      els.ticksList,
      els.ordersList,
      els.trailingList,
    ]) {
      container.innerHTML = "";
      container.appendChild(emptyNode());
    }
    els.positionsBody.innerHTML = `<tr><td colspan="8"><div class="empty-state">No active positions.</div></td></tr>`;
    els.positionsMeta.textContent = "-";
    els.focusLabel.textContent = "auto";
    els.focusSelect.innerHTML = `<option value="">Auto</option>`;
    renderSidebarBots([]);
  }

  function render() {
    const botEntries = sortedBotEntries();
    if (!botEntries.length) {
      renderNoBots();
      return;
    }

    renderBotOverview(botEntries);
    renderSidebarBots(botEntries);
    const focusedKey = ensureFocusedBotKey();
    const botEntry = currentBotEntry();
    const snapshot = botEntry?.snapshot || null;
    const payload = snapshot?.payload || null;
    if (!focusedKey || !botEntry || !snapshot || !payload) {
      renderNoBots();
      return;
    }

    const focusSymbol = selectedFocusSymbol(focusedKey, payload);
    const account = payload.account || {};
    const health = payload.health || {};
    const activeCount = botEntries.filter(([, entry]) => botRelayStatus(entry) === "active").length;
    const staleCount = botEntries.filter(([, entry]) => botRelayStatus(entry) === "stale").length;
    const focusPresence = botRelayStatus(botEntry);
    els.heroTitle.textContent = `${botEntries.length} ${botEntries.length === 1 ? "bot" : "bots"} visible`;
    els.heroSubtitle.textContent = `Focused ${botDisplayLabel(focusedKey)} · ${focusPresence} · ${activeCount} active${staleCount ? ` / ${staleCount} stale` : ""} · equity ${fmtCompact(account.equity, 2)} · loop ${fmtCompact(health.last_loop_duration_ms, 0)} ms · snapshot ${fmtAgeMs(snapshot.ts)} old`;
    els.summaryMeta.textContent = botDisplayLabel(focusedKey);
    setChip(els.snapshotStatus, `Snapshot: ${activeCount} active${staleCount ? ` / ${staleCount} stale` : ""} · focused ${fmtAgeMs(snapshot.ts)}`, focusPresence === "stale" ? "is-warn" : "is-ok");
    setChip(
      els.focusStatus,
      `Focus: ${botDisplayLabel(focusedKey)}${focusSymbol ? ` · ${shortSymbol(focusSymbol)}` : " · auto"}`,
      "is-ok"
    );
    setChip(els.relayStatus, `Relay: ${window.location.origin}`, "");

    buildSummaryCards(payload);
    renderFocus(payload, focusSymbol);
    renderPositions(payload, focusSymbol);
    renderTrailing(payload, focusSymbol);
    renderForager(payload);
    renderUnstuck(payload);
    renderEvents(botEntry, focusSymbol);
    renderTicks(payload, botEntry, focusSymbol);
    renderOrders(payload, focusSymbol);
    updateFocusOptions(payload, focusedKey);
  }

  // ---- Config view ----

  const ACTIVE_PATHS = { bot: "paper.hjson", scenario: "scenarios/paper_btc.hjson" };

  const BOT_CONFIG_SCHEMA = [
    { title: "Long — Position Sizing", fields: [
      { path: ["bot","long","n_positions"], label: "Max positions", type: "number", step: "1", min: "0" },
      { path: ["bot","long","total_wallet_exposure_limit"], label: "Wallet exposure limit", type: "number", step: "0.01", min: "0" },
      { path: ["bot","long","entry_initial_qty_pct"], label: "Initial entry size", type: "number", step: "0.001", min: "0" },
      { path: ["bot","long","entry_grid_spacing_pct"], label: "Grid spacing", type: "number", step: "0.001", min: "0" },
      { path: ["bot","long","entry_initial_ema_dist"], label: "EMA entry distance", type: "number", step: "0.0001" },
      { path: ["bot","long","entry_grid_double_down_factor"], label: "Double down factor", type: "number", step: "0.1", min: "0" },
    ]},
    { title: "Long — Close", fields: [
      { path: ["bot","long","close_grid_markup_start"], label: "Close markup start", type: "number", step: "0.001", min: "0" },
      { path: ["bot","long","close_grid_markup_end"], label: "Close markup end", type: "number", step: "0.001", min: "0" },
      { path: ["bot","long","close_grid_qty_pct"], label: "Close grid qty pct", type: "number", step: "0.01", min: "0" },
    ]},
    { title: "Long — Risk", fields: [
      { path: ["bot","long","hsl_enabled"], label: "Stop-loss (HSL)", type: "boolean" },
      { path: ["bot","long","hsl_red_threshold"], label: "HSL panic threshold", type: "number", step: "0.01", min: "0" },
      { path: ["bot","long","unstuck_loss_allowance_pct"], label: "Unstuck loss allowance", type: "number", step: "0.01", min: "0" },
      { path: ["bot","long","unstuck_threshold"], label: "Unstuck threshold", type: "number", step: "0.1", min: "0" },
    ]},
    { title: "Short — Position Sizing", fields: [
      { path: ["bot","short","n_positions"], label: "Max positions", type: "number", step: "1", min: "0" },
      { path: ["bot","short","total_wallet_exposure_limit"], label: "Wallet exposure limit", type: "number", step: "0.01", min: "0" },
      { path: ["bot","short","hsl_enabled"], label: "Stop-loss (HSL)", type: "boolean" },
    ]},
    { title: "Coin Selection", fields: [
      { path: ["live","approved_coins","long"], label: "Approved coins — long", type: "array_csv" },
      { path: ["live","approved_coins","short"], label: "Approved coins — short", type: "array_csv" },
      { path: ["live","ignored_coins","long"], label: "Ignored coins — long", type: "array_csv" },
      { path: ["live","ignored_coins","short"], label: "Ignored coins — short", type: "array_csv" },
    ]},
    { title: "Account", fields: [
      { path: ["live","leverage"], label: "Leverage", type: "number", step: "1", min: "1" },
      { path: ["live","execution_delay_seconds"], label: "Execution delay (s)", type: "number", step: "0.1", min: "0" },
      { path: ["live","market_orders_allowed"], label: "Allow market orders", type: "boolean" },
    ]},
  ];

  const SCENARIO_CONFIG_SCHEMA = [
    { title: "Simulation Settings", fields: [
      { path: ["name"], label: "Scenario name", type: "text" },
      { path: ["start_time"], label: "Start time (UTC)", type: "text" },
      { path: ["tick_interval_seconds"], label: "Tick interval (s)", type: "number", step: "1", min: "1" },
      { path: ["boot_index"], label: "Boot tick index", type: "number", step: "1", min: "0" },
    ]},
    { title: "Account", fields: [
      { path: ["account","balance"], label: "Starting balance", type: "number", step: "1", min: "0" },
    ]},
  ];

  const cfgState = {
    files: [],
    selected: null,
    rawContent: "",
    parsedContent: null,
    dirty: false,
    tab: "form",
    saving: false,
  };

  function isBotConfig(parsed) {
    return parsed && typeof parsed === "object" && parsed.bot && parsed.bot.long;
  }

  function isScenarioConfig(parsed) {
    return parsed && typeof parsed === "object" && Array.isArray(parsed.timeline);
  }

  function configSchemaFor(parsed) {
    if (isBotConfig(parsed)) return BOT_CONFIG_SCHEMA;
    if (isScenarioConfig(parsed)) return SCENARIO_CONFIG_SCHEMA;
    return null;
  }

  function hasFormSupport(parsed) {
    return configSchemaFor(parsed) !== null;
  }

  function activateTargetFor(path, parsed) {
    if (!path || !parsed) return null;
    if (isBotConfig(parsed)) return ACTIVE_PATHS.bot;
    if (isScenarioConfig(parsed)) return ACTIVE_PATHS.scenario;
    return null;
  }

  function isActivePath(path) {
    return path === ACTIVE_PATHS.bot || path === ACTIVE_PATHS.scenario;
  }

  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    return `${(n / 1024).toFixed(1)} KB`;
  }

  function getNestedValue(obj, path) {
    let cur = obj;
    for (const key of path) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = cur[key];
    }
    return cur;
  }

  function setNestedValue(obj, path, value) {
    let cur = obj;
    for (let i = 0; i < path.length - 1; i++) {
      if (cur[path[i]] == null || typeof cur[path[i]] !== "object") cur[path[i]] = {};
      cur = cur[path[i]];
    }
    cur[path[path.length - 1]] = value;
  }

  function cfgSaveStatus(msg, tone) {
    const el = document.getElementById("config-save-status");
    if (!el) return;
    el.textContent = msg;
    el.className = "config-save-status" + (tone ? " " + tone : "");
    if (tone === "is-ok") setTimeout(() => { if (el.textContent === msg) { el.textContent = ""; el.className = "config-save-status"; } }, 4000);
  }

  function renderConfigFileList() {
    const el = document.getElementById("config-file-list");
    if (!el) return;
    el.innerHTML = "";
    if (!cfgState.files.length) {
      el.innerHTML = `<div class="empty-state" style="margin:8px 0">No config files found.</div>`;
      return;
    }
    const groups = {};
    for (const f of cfgState.files) {
      const dir = f.dir || "";
      if (!groups[dir]) groups[dir] = [];
      groups[dir].push(f);
    }
    for (const dir of Object.keys(groups).sort()) {
      if (dir) {
        const h = document.createElement("p");
        h.className = "config-file-group-title";
        h.textContent = dir + "/";
        el.appendChild(h);
      }
      for (const file of groups[dir]) {
        const isActive = isActivePath(file.path);
        const isSelected = file.path === cfgState.selected;
        const item = document.createElement("div");
        item.className = "config-file-item" + (isSelected ? " is-selected" : "");
        item.innerHTML = `
          <span class="config-file-item-name">${escapeHtml(file.name)}${isActive ? `<span class="config-active-badge">active</span>` : ""}</span>
          <span class="config-file-item-size">${escapeHtml(fmtBytes(file.size))}</span>
          <button class="config-file-dup-btn" title="Duplicate" data-dup="${escapeHtml(file.path)}">&#x29C9;</button>
        `;
        item.addEventListener("click", (e) => {
          if (e.target.closest(".config-file-dup-btn")) return;
          selectConfigFile(file.path);
        });
        item.querySelector(".config-file-dup-btn").addEventListener("click", (e) => {
          e.stopPropagation();
          duplicateConfigFile(file.path);
        });
        el.appendChild(item);
      }
    }
  }

  async function loadConfigFiles() {
    try {
      const resp = await fetch("/configs", { cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      cfgState.files = data.files || [];
      renderConfigFileList();
    } catch (err) {
      const el = document.getElementById("config-file-list");
      if (el) el.innerHTML = `<div class="empty-state" style="margin:8px 0">Load error: ${escapeHtml(String(err.message))}</div>`;
    }
  }

  async function selectConfigFile(path) {
    if (cfgState.dirty && !window.confirm("Unsaved changes will be lost. Continue?")) return;
    try {
      const resp = await fetch(`/configs/content?file=${encodeURIComponent(path)}`, { cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      cfgState.selected = path;
      cfgState.rawContent = data.content || "";
      cfgState.parsedContent = data.parsed || null;
      cfgState.dirty = false;
      cfgState.tab = hasFormSupport(data.parsed) ? "form" : "raw";
      renderConfigEditor();
      renderConfigFileList();
    } catch (err) {
      alert(`Failed to load ${path}: ${err.message}`);
    }
  }

  function renderConfigEditor() {
    const emptyEl = document.getElementById("config-editor-empty");
    const loadedEl = document.getElementById("config-editor-loaded");
    if (!emptyEl || !loadedEl) return;

    if (!cfgState.selected) {
      emptyEl.style.display = "";
      loadedEl.style.display = "none";
      return;
    }
    emptyEl.style.display = "none";
    loadedEl.style.display = "flex";

    document.getElementById("config-file-name").textContent = cfgState.selected;

    const supportsForm = hasFormSupport(cfgState.parsedContent);
    const tabForm = document.getElementById("config-tab-form");
    const tabRaw = document.getElementById("config-tab-raw");
    const formView = document.getElementById("config-form-view");
    const rawView = document.getElementById("config-raw-view");
    const saveBtn = document.getElementById("config-save-btn");
    const activateBtn = document.getElementById("config-activate-btn");

    tabForm.style.display = supportsForm ? "" : "none";
    if (!supportsForm) cfgState.tab = "raw";

    tabForm.classList.toggle("is-active", cfgState.tab === "form");
    tabRaw.classList.toggle("is-active", cfgState.tab === "raw");

    if (cfgState.tab === "form") {
      formView.style.display = "";
      rawView.style.display = "none";
      renderConfigForm(cfgState.parsedContent);
    } else {
      formView.style.display = "none";
      rawView.style.display = "";
      document.getElementById("config-raw-textarea").value = cfgState.rawContent;
    }

    // Activate button
    const activeTarget = activateTargetFor(cfgState.selected, cfgState.parsedContent);
    const alreadyActive = isActivePath(cfgState.selected);
    if (activeTarget && !alreadyActive) {
      activateBtn.style.display = "";
      activateBtn.textContent = `Use as ${activeTarget}`;
      activateBtn.dataset.target = activeTarget;
    } else {
      activateBtn.style.display = "none";
    }

    saveBtn.disabled = !cfgState.dirty;
  }

  function renderConfigForm(parsed) {
    const formEl = document.getElementById("config-form-view");
    if (!formEl) return;
    formEl.innerHTML = "";
    const schema = configSchemaFor(parsed);
    if (!schema || !parsed) {
      formEl.innerHTML = `<div class="empty-state">Could not parse config for form editing. Use Raw tab.</div>`;
      return;
    }
    for (const section of schema) {
      const sectionEl = document.createElement("div");
      sectionEl.className = "config-form-section";
      const headEl = document.createElement("div");
      headEl.className = "config-form-section-head";
      const titleEl = document.createElement("p");
      titleEl.className = "config-form-section-title";
      titleEl.textContent = section.title;
      headEl.appendChild(titleEl);
      sectionEl.appendChild(headEl);
      const gridEl = document.createElement("div");
      gridEl.className = "config-form-grid";
      for (const field of section.fields) {
        gridEl.appendChild(buildConfigFormField(field, parsed));
      }
      sectionEl.appendChild(gridEl);
      formEl.appendChild(sectionEl);
    }
  }

  function buildConfigFormField(field, parsed) {
    const value = getNestedValue(parsed, field.path);
    const wrapper = document.createElement("div");
    wrapper.className = "config-form-field";
    const label = document.createElement("label");
    label.textContent = field.label;
    wrapper.appendChild(label);

    let input;
    if (field.type === "boolean") {
      const row = document.createElement("div");
      row.className = "config-form-checkbox-row";
      input = document.createElement("input");
      input.type = "checkbox";
      input.className = "config-form-checkbox";
      input.checked = Boolean(value);
      row.appendChild(input);
      wrapper.appendChild(row);
    } else if (field.type === "array_csv") {
      input = document.createElement("input");
      input.type = "text";
      input.className = "config-form-input";
      input.value = Array.isArray(value) ? value.join(", ") : (value != null ? String(value) : "");
      input.placeholder = "BTC, ETH";
      wrapper.appendChild(input);
    } else if (field.type === "text") {
      input = document.createElement("input");
      input.type = "text";
      input.className = "config-form-input";
      input.value = value != null ? String(value) : "";
      wrapper.appendChild(input);
    } else {
      input = document.createElement("input");
      input.type = "number";
      input.className = "config-form-input";
      input.value = value != null ? String(value) : "";
      if (field.step) input.step = field.step;
      if (field.min != null) input.min = field.min;
      if (field.max != null) input.max = field.max;
      wrapper.appendChild(input);
    }

    input.dataset.cfgPath = JSON.stringify(field.path);
    input.dataset.cfgType = field.type;
    input.addEventListener("input", () => {
      cfgState.dirty = true;
      const saveBtn = document.getElementById("config-save-btn");
      if (saveBtn) saveBtn.disabled = false;
      cfgSaveStatus("");
    });
    return wrapper;
  }

  function collectFormValues() {
    const formEl = document.getElementById("config-form-view");
    if (!formEl) return cfgState.parsedContent;
    const out = JSON.parse(JSON.stringify(cfgState.parsedContent || {}));
    for (const input of formEl.querySelectorAll("[data-cfg-path]")) {
      const path = JSON.parse(input.dataset.cfgPath);
      const type = input.dataset.cfgType;
      let val;
      if (type === "boolean") {
        val = input.checked;
      } else if (type === "array_csv") {
        val = input.value.split(",").map(s => s.trim()).filter(Boolean);
      } else if (type === "text") {
        val = input.value;
      } else {
        val = parseFloat(input.value);
        if (isNaN(val)) val = 0;
      }
      setNestedValue(out, path, val);
    }
    return out;
  }

  async function saveConfigFile() {
    if (!cfgState.selected || cfgState.saving) return;
    cfgState.saving = true;
    const saveBtn = document.getElementById("config-save-btn");
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }

    let content;
    if (cfgState.tab === "form") {
      const values = collectFormValues();
      content = JSON.stringify(values, null, 2);
    } else {
      content = document.getElementById("config-raw-textarea").value;
    }

    try {
      const resp = await fetch(`/configs/content?file=${encodeURIComponent(cfgState.selected)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      cfgState.rawContent = content;
      cfgState.dirty = false;
      if (saveBtn) saveBtn.textContent = "Save";
      if (saveBtn) saveBtn.disabled = true;
      cfgSaveStatus("Saved ✓", "is-ok");
      // Refresh file sizes
      loadConfigFiles();
    } catch (err) {
      if (saveBtn) { saveBtn.textContent = "Save"; saveBtn.disabled = false; }
      cfgSaveStatus(`Error: ${err.message}`, "is-error");
    }
    cfgState.saving = false;
  }

  async function duplicateConfigFile(path) {
    const base = path.split("/").pop();
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    const suggestion = `${stem}_copy${ext}`;
    const newName = window.prompt(`New filename for copy of "${base}":`, suggestion);
    if (!newName || !newName.trim()) return;
    try {
      const resp = await fetch("/configs/duplicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: path, name: newName.trim() }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      await loadConfigFiles();
      selectConfigFile(data.path);
    } catch (err) {
      alert(`Duplicate failed: ${err.message}`);
    }
  }

  async function activateConfigFile() {
    const activateBtn = document.getElementById("config-activate-btn");
    if (!activateBtn || !cfgState.selected) return;
    const targetPath = activateBtn.dataset.target;
    if (!targetPath) return;

    const confirmed = window.confirm(
      `Copy "${cfgState.selected}" → "${targetPath}"?\n\nThe bot will use this config on next start.`
    );
    if (!confirmed) return;

    let content;
    if (cfgState.tab === "form" && cfgState.dirty) {
      content = JSON.stringify(collectFormValues(), null, 2);
    } else {
      content = cfgState.rawContent;
    }

    try {
      const resp = await fetch(`/configs/content?file=${encodeURIComponent(targetPath)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      alert(`Done. "${targetPath}" updated.\nRestart the bot to apply the new config.`);
      await loadConfigFiles();
    } catch (err) {
      alert(`Activation failed: ${err.message}`);
    }
  }

  function initConfigView() {
    // Tab switching
    document.querySelectorAll(".config-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        if (tab.dataset.tab === "form" && !hasFormSupport(cfgState.parsedContent)) return;
        const goingToRaw = tab.dataset.tab === "raw";
        const goingToForm = tab.dataset.tab === "form";

        if (goingToRaw && cfgState.tab === "form" && cfgState.dirty) {
          cfgState.rawContent = JSON.stringify(collectFormValues(), null, 2);
        } else if (goingToForm && cfgState.tab === "raw") {
          const rawVal = document.getElementById("config-raw-textarea")?.value || "";
          try {
            cfgState.parsedContent = JSON.parse(rawVal);
            cfgState.rawContent = rawVal;
          } catch {
            alert("Cannot switch to Form: raw content is not valid JSON.");
            return;
          }
        }
        cfgState.tab = tab.dataset.tab;
        renderConfigEditor();
      });
    });

    document.getElementById("config-save-btn")?.addEventListener("click", saveConfigFile);
    document.getElementById("config-activate-btn")?.addEventListener("click", activateConfigFile);
    document.getElementById("config-refresh-btn")?.addEventListener("click", loadConfigFiles);

    document.getElementById("config-raw-textarea")?.addEventListener("input", () => {
      cfgState.dirty = true;
      const saveBtn = document.getElementById("config-save-btn");
      if (saveBtn) saveBtn.disabled = false;
      cfgSaveStatus("");
    });
  }

  async function fetchSnapshot() {
    const response = await fetch("/snapshot", { cache: "no-store" });
    if (!response.ok) throw new Error(`snapshot HTTP ${response.status}`);
    const payload = await response.json();
    ingestSnapshotPayload(payload);
    render();
  }

  function connectWs() {
    if (state.ws) state.ws.close();
    const url = new URL("/ws", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    state.ws = ws;
    setChip(els.wsStatus, "WS: connecting", "is-warn");
    ws.onopen = () => setChip(els.wsStatus, "WS: live", "is-ok");
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      state.lastWsTs = Date.now();
      if (message.type === "snapshot" || message.type === "snapshot_bundle") {
        ingestSnapshotPayload(message);
      } else if (message.type === "event") {
        pushEvent(message);
      } else if (message.type === "history" && message.stream === "price_ticks") {
        pushTick(message);
      }
      render();
    };
    ws.onclose = () => {
      setChip(els.wsStatus, "WS: reconnecting", "is-warn");
      if (state.reconnectTimer) window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = window.setTimeout(connectWs, 1000);
    };
    ws.onerror = () => setChip(els.wsStatus, "WS: error", "is-bad");
  }

  // ---- Bot control ----
  const botCtrl = {
    btn: document.getElementById("bot-control-btn"),
    labelEl: null,
    pollTimer: null,
  };
  if (botCtrl.btn) botCtrl.labelEl = botCtrl.btn.querySelector(".bot-control-label");

  const BOT_CTRL_LABELS = {
    running:     "● Paper · Running — Stop",
    stopped:     "◌ Paper · Stopped — Start",
    busy:        "…",
    loading:     "…",
    not_found:   "Paper container not found",
    error:       "Docker error",
    unavailable: "Control N/A",
  };

  function setBotControlState(state) {
    if (!botCtrl.btn) return;
    botCtrl.btn.dataset.state = state;
    if (botCtrl.labelEl) botCtrl.labelEl.textContent = BOT_CTRL_LABELS[state] ?? state;
    botCtrl.btn.disabled = state === "loading" || state === "busy";
  }

  async function fetchBotStatus() {
    try {
      const resp = await fetch("/control/status", { cache: "no-store" });
      if (!resp.ok) { setBotControlState("error"); return; }
      const data = await resp.json();
      setBotControlState(data.status ?? "error");
    } catch {
      setBotControlState("error");
    }
  }

  async function handleBotControlClick() {
    if (!botCtrl.btn) return;
    const current = botCtrl.btn.dataset.state;
    if (current !== "running" && current !== "stopped") return;
    const action = current === "running" ? "stop" : "start";
    setBotControlState("busy");
    try {
      const resp = await fetch(`/control/${action}`, { method: "POST", cache: "no-store" });
      const data = resp.ok ? await resp.json() : {};
      setBotControlState(data.status ?? "error");
      // Poll a few more times to catch delayed state changes
      let polls = 0;
      const pollId = window.setInterval(async () => {
        await fetchBotStatus();
        if (++polls >= 5) window.clearInterval(pollId);
      }, 1200);
    } catch {
      setBotControlState("error");
    }
  }

  function initBotControl() {
    if (!botCtrl.btn) return;
    botCtrl.btn.addEventListener("click", handleBotControlClick);
    fetchBotStatus();
    // Refresh status every 15 s
    botCtrl.pollTimer = window.setInterval(fetchBotStatus, 15000);
  }

  // ---- Per-bot control ----
  const perBotCtrl = {
    managedKeys: new Set(),   // "exchange/user" strings
    states: new Map(),        // "exchange/user" → state string
  };

  async function fetchManagedKeys() {
    try {
      const resp = await fetch("/control/managed", { cache: "no-store" });
      if (!resp.ok) return;
      const data = await resp.json();
      perBotCtrl.managedKeys = new Set((data.managed || []).map(m => m.key));
    } catch { /* ignore */ }
  }

  async function fetchPerBotStatus(key) {
    const [ex, us] = splitBotKey(key);
    try {
      const resp = await fetch(`/control/${encodeURIComponent(ex)}/${encodeURIComponent(us)}/status`, { cache: "no-store" });
      if (!resp.ok) { perBotCtrl.states.set(key, "error"); return; }
      const data = await resp.json();
      perBotCtrl.states.set(key, data.status ?? "error");
    } catch {
      perBotCtrl.states.set(key, "error");
    }
  }

  async function handleBotCardCtrlClick(key) {
    const current = perBotCtrl.states.get(key) ?? "loading";
    if (current !== "running" && current !== "stopped") return;
    const action = current === "running" ? "stop" : "start";
    perBotCtrl.states.set(key, "busy");
    updateBotCardCtrlBtn(key);
    const [ex, us] = splitBotKey(key);
    try {
      const resp = await fetch(`/control/${encodeURIComponent(ex)}/${encodeURIComponent(us)}/${action}`, { method: "POST", cache: "no-store" });
      const data = resp.ok ? await resp.json() : {};
      perBotCtrl.states.set(key, data.status ?? "error");
      updateBotCardCtrlBtn(key);
      let polls = 0;
      const pollId = window.setInterval(async () => {
        await fetchPerBotStatus(key);
        updateBotCardCtrlBtn(key);
        if (++polls >= 5) window.clearInterval(pollId);
      }, 1200);
    } catch {
      perBotCtrl.states.set(key, "error");
      updateBotCardCtrlBtn(key);
    }
  }

  const PER_BOT_CTRL_LABELS = {
    running:     "● Stop",
    stopped:     "◌ Start",
    busy:        "…",
    loading:     "…",
    unavailable: "N/A",
    not_found:   "Not found",
    error:       "Error",
  };
  const PER_BOT_CTRL_TONES = {
    running: "is-running",
    stopped: "is-stopped",
    busy:    "is-busy",
  };

  function updateBotCardCtrlBtn(key) {
    const btn = document.querySelector(`.overview-card[data-bot-key="${CSS.escape(key)}"] .bot-card-ctrl`);
    if (!btn) return;
    const s = perBotCtrl.states.get(key) ?? "loading";
    btn.dataset.state = s;
    btn.disabled = s === "loading" || s === "busy";
    btn.textContent = PER_BOT_CTRL_LABELS[s] ?? s;
    btn.className = `bot-card-ctrl ${PER_BOT_CTRL_TONES[s] ?? ""}`.trim();
  }

  async function initPerBotControl() {
    await fetchManagedKeys();
    for (const key of perBotCtrl.managedKeys) {
      await fetchPerBotStatus(key);
    }
    window.setInterval(async () => {
      for (const key of perBotCtrl.managedKeys) {
        await fetchPerBotStatus(key);
        updateBotCardCtrlBtn(key);
      }
    }, 15000);
  }

  function initViewSwitching() {
    const navItems = document.querySelectorAll(".nav-item[data-view]");
    const views = document.querySelectorAll(".view");
    navItems.forEach(item => {
      item.addEventListener("click", () => {
        navItems.forEach(n => n.classList.remove("is-active"));
        views.forEach(v => v.classList.remove("is-active"));
        item.classList.add("is-active");
        const viewEl = document.getElementById("view-" + item.dataset.view);
        if (viewEl) viewEl.classList.add("is-active");
        if (item.dataset.view === "config") loadConfigFiles();
      });
    });
  }

  function bindUi() {
    initBotControl();
    initConfigView();
    initViewSwitching();
    initPerBotControl();
    els.focusSelect.addEventListener("change", () => {
      setFocusSymbol(els.focusSelect.value || "");
    });
    els.refreshButton.addEventListener("click", async () => {
      try {
        await fetchSnapshot();
      } catch (error) {
        setChip(els.snapshotStatus, `Snapshot: ${error.message}`, "is-bad");
      }
    });
    els.botOverview.addEventListener("click", (event) => {
      const target = event.target.closest("[data-bot-key]");
      if (!target) return;
      setFocusedBotKey(target.dataset.botKey || "");
    });
    if (els.sidebarBotList) {
      els.sidebarBotList.addEventListener("click", (event) => {
        const target = event.target.closest("[data-bot-key]");
        if (target) setFocusedBotKey(target.dataset.botKey || "");
      });
    }
    for (const container of [
      els.positionsBody,
      els.trailingList,
      els.eventsList,
      els.ticksList,
      els.ordersList,
    ]) {
      container.addEventListener("click", (event) => {
        const target = event.target.closest("[data-symbol]");
        if (!target) return;
        setFocusSymbol(target.dataset.symbol || "");
      });
    }
  }

  async function start() {
    bindUi();
    try {
      await fetchSnapshot();
      connectWs();
      state.snapshotTimer = window.setInterval(() => {
        fetchSnapshot().catch((error) => setChip(els.snapshotStatus, `Snapshot: ${error.message}`, "is-bad"));
      }, 3000);
    } catch (error) {
      setChip(els.snapshotStatus, `Snapshot: ${error.message}`, "is-bad");
      els.heroTitle.textContent = "Snapshot load failed";
      els.heroSubtitle.textContent = String(error.message || error);
    }
  }

  start();
})();
