const ASSET = "pixelDeck/PixelDeck/4X";
const SUIT_DIR = { spades: "SuitOfSpades", hearts: "SuitOfHearts", diamonds: "SuitOfDiamonds", clubs: "SuitOfClubs" };
const SUIT_FILE = { spades: "suitOfSpades", hearts: "suitOfHearts", diamonds: "suitOfDiamonds", clubs: "suitOfClubs" };
const $ = (id) => document.getElementById(id);
const screens = ["lobby", "roomPanel", "game"];

let panelMode = "create";
let session = null;
let state = null;
let pollTimer = null;
let polling = false;
let playing = false;
let creatingRoom = false;
let lastEventId = 0;
let lastTableCount = 0;

function showScreen(id) {
  screens.forEach((screen) => $(screen).classList.toggle("hidden", screen !== id));
}

function cardImage(card) {
  if (card.suit === "joker") return `${ASSET}/joker${card.variant}(4x).png`;
  return `${ASSET}/${SUIT_DIR[card.suit]}/${SUIT_FILE[card.suit]}(4x)${card.rank}.png`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(response.ok ? "Server returned an invalid response" : `Server route unavailable (${response.status})`);
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function createOnlineRoom(name, mode, target, quick = false) {
  if (creatingRoom) return;
  creatingRoom = true;
  document.querySelectorAll(".mode-option, #roomSubmit").forEach((button) => button.disabled = true);
  try {
    const joined = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ name, mode, target, quick })
    });
    enterRoom(joined);
  } finally {
    creatingRoom = false;
    document.querySelectorAll(".mode-option, #roomSubmit").forEach((button) => button.disabled = false);
  }
}

async function joinOnlineRoom(name, code, team) {
  const joined = await api(`/api/rooms/${encodeURIComponent(code.toUpperCase())}/join`, {
    method: "POST",
    body: JSON.stringify({ name, team })
  });
  enterRoom(joined);
}

function enterRoom(joined) {
  session = joined;
  state = null;
  lastEventId = 0;
  lastTableCount = 0;
  sessionStorage.setItem("sweep-session", JSON.stringify(session));
  showScreen("game");
  clearInterval(pollTimer);
  pollState();
  pollTimer = setInterval(pollState, 750);
}

async function pollState() {
  if (!session || polling) return;
  const activeSession = session;
  polling = true;
  try {
    const next = await api(`/api/rooms/${activeSession.code}/state?token=${activeSession.token}`);
    if (session !== activeSession) return;
    const event = next.event && next.event.id > lastEventId ? next.event : null;
    const previousState = state;
    const previousTableCount = previousState?.table?.length || 0;
    state = next;
    if (event) {
      lastEventId = event.id;
      await handleEvent(event, previousState);
    } else {
      render(previousTableCount);
    }
  } catch (error) {
    if (session !== activeSession) return;
    toast(error.message);
    if (error.message === "Room not found" || error.message === "Invalid player token") leaveRoom();
  } finally {
    polling = false;
  }
}

async function playOnlineCard(cardId) {
  if (playing || !state || state.turn !== state.seat || state.phase !== "playing") return;
  playing = true;
  try {
    const next = await api(`/api/rooms/${session.code}/play`, {
      method: "POST",
      body: JSON.stringify({ token: session.token, cardId })
    });
    const event = next.event && next.event.id > lastEventId ? next.event : null;
    const previousState = state;
    const previousTableCount = previousState.table.length;
    state = next;
    if (event) {
      lastEventId = event.id;
      await handleEvent(event, previousState);
    } else {
      render(previousTableCount);
    }
  } catch (error) {
    toast(error.message);
  } finally {
    playing = false;
  }
}

async function handleEvent(event, previousState = null) {
  if (event.type === "play") {
    if (previousState) renderVisualState(withPlayedCardRemoved(previousState, event));
    await playCardAnimation(event.seat === state.seat ? "player" : "opponent", event.card);
    render(previousState?.table?.length || 0);
    if (event.capture) {
      const side = state.players[event.seat].team;
      playCaptureEffect(side, event.capturedCount, event.sweep);
      toast(event.sweep ? `${state.players[event.seat].name} scores a Sweep!` : `${state.players[event.seat].name} captures ${event.capturedCount} cards`);
    }
  }
  if (event.type === "round-end") {
    render();
    showRoundResults(event.points);
  }
  if (event.type === "surrender") {
    render();
    toast(`${state.players[event.seat]?.name || "A player"} surrendered`);
    showSurrenderResult();
  }
}

function withPlayedCardRemoved(previousState, event) {
  const players = previousState.players.map((player) =>
    player.seat === event.seat ? { ...player, handCount: Math.max(0, player.handCount - 1) } : player
  );
  const hand = event.seat === previousState.seat
    ? previousState.hand.filter((card) => card.id !== event.card.id)
    : previousState.hand;
  return { ...previousState, players, hand };
}

function renderVisualState(visualState) {
  const currentState = state;
  state = visualState;
  render();
  state = currentState;
}

function render(previousTableCount = lastTableCount) {
  if (!state) return;
  $("game").dataset.mode = state.mode;
  $("roomLabel").textContent = `ROOM ${state.code} · ${state.mode.toUpperCase()}`;
  $("scoreTarget").textContent = state.target;
  $("roundNumber").textContent = state.round || 1;
  $("deckCount").textContent = state.deckCount;
  $("waitingOverlay").classList.toggle("hidden", state.phase !== "waiting");
  $("addBotButton").classList.toggle("hidden", state.phase !== "waiting" || !state.isHost || state.players.length >= state.maxPlayers);
  $("startRoomButton").classList.toggle("hidden", state.phase !== "waiting" || !state.isHost);
  $("startRoomButton").disabled = state.players.length !== state.maxPlayers;
  $("surrenderButton").classList.toggle("hidden", !["opening", "playing"].includes(state.phase));
  if (state.phase === "waiting") renderWaitingTeams();

  renderOpponents();
  renderScores();
  renderTable(previousTableCount);
  renderHand();

  const me = state.players[state.seat];
  if (!me) return;
  const isMyTurn = state.turn === state.seat && state.phase === "playing";
  const turnPlayer = state.players[state.turn];
  const title = state.phase === "opening" ? "Opening deal" : state.phase === "waiting" ? "Waiting" : isMyTurn ? "Your turn" : `${turnPlayer?.name || "Player"}'s turn`;
  const help = state.phase === "opening" ? `${state.table.length} of 4 table cards` : isMyTurn ? "Play one card" : state.phase === "playing" ? "Waiting..." : "Round complete";
  $("turnIndicator").innerHTML = `<span></span><strong>${title}</strong><small>${help}</small>`;
  $("playerLabel").textContent = `${me.name}${state.mode === "2v2" ? ` · Team ${me.team + 1}` : ""}`;
  $("playerStatus").textContent = isMyTurn ? "Your turn" : "Waiting";
  $("playerCapturedCount").textContent = me.capturedCount;
  $("capturedCount").textContent = me.capturedCount;
  $("sweepCount").textContent = me.sweeps;
  $("playerCaptureBadge").dataset.side = me.team;
  lastTableCount = state.table.length;
}

function renderWaiting() {
  $("waitingCode").textContent = state.code;
  $("waitingStatus").textContent = `${state.players.length} of ${state.maxPlayers} players joined · ${state.mode}`;
  $("waitingSeats").innerHTML = Array.from({ length: state.maxPlayers }, (_, seat) => {
    const player = state.players[seat];
    return `<span class="${player ? `filled ${player.bot ? "bot-seat" : ""}` : ""}">${player ? `${escapeHtml(player.name)}${player.bot ? " · BOT" : ""}` : `Seat ${seat + 1}`}</span>`;
  }).join("");
}

function renderWaitingTeams() {
  $("waitingCode").textContent = state.code;
  $("waitingStatus").textContent = `${state.players.length} of ${state.maxPlayers} players joined - ${state.isHost ? "Start when ready" : "Waiting for host"}`;
  if (state.mode === "2v2") {
    $("waitingSeats").innerHTML = [0, 1].map((team) => {
      const players = state.players.filter((player) => player.team === team);
      const seats = Array.from({ length: 2 }, (_, index) => {
        const player = players[index];
        return `<span class="${player ? `filled ${player.bot ? "bot-seat" : ""}` : ""}">${player ? `${escapeHtml(player.name)}${player.bot ? " - BOT" : ""}` : "Open seat"}</span>`;
      }).join("");
      return `<section class="waiting-team"><b>Team ${team + 1}</b>${seats}</section>`;
    }).join("");
    return;
  }
  $("waitingSeats").innerHTML = Array.from({ length: state.maxPlayers }, (_, seat) => {
    const player = state.players[seat];
    return `<span class="${player ? `filled ${player.bot ? "bot-seat" : ""}` : ""}">${player ? `${escapeHtml(player.name)}${player.bot ? " - BOT" : ""}` : `Seat ${seat + 1}`}</span>`;
  }).join("");
}

function renderOpponents() {
  const opponents = state.players.filter((player) => player.seat !== state.seat);
  $("opponentsGrid").innerHTML = opponents.map((player, index) => `
    <article class="opponent-seat opponent-position-${index + 1} ${state.turn === player.seat && state.phase === "playing" ? "active-seat" : ""}">
      <div class="player-label"><span class="avatar">${escapeHtml(player.name[0] || "P")}</span><span><strong>${escapeHtml(player.name)}</strong><small>${state.mode === "2v2" ? `Team ${player.team + 1}` : `Score ${player.score}`}</small></span></div>
      <div class="capture-badge" data-side="${player.team}"><span class="mini-card-stack"></span><b>${player.capturedCount}</b><small>CAPTURED</small></div>
      <div class="hand opponent-hand">${Array.from({ length: player.handCount }, () => `<span class="card card-back"></span>`).join("")}</div>
    </article>`).join("");
}

function renderScores() {
  const sides = state.mode === "2v2"
    ? state.scores.map((score, side) => ({ name: `Team ${side + 1}`, side, score }))
    : state.players.map((player) => ({ name: player.name, side: player.team, score: player.score }));
  $("scoreRows").innerHTML = sides.map((side) => `
    <div class="score-row" id="score-side-${side.side}">
      <span class="avatar">${escapeHtml(side.name[0])}</span><strong>${escapeHtml(side.name)}</strong><span class="score-value">${side.score}</span>
    </div>`).join("");
}

function renderTable(previousTableCount) {
  const tableCards = $("tableCards");
  tableCards.innerHTML = "";
  state.table.forEach((card, index) => {
    const element = renderCard(card);
    element.style.setProperty("--stack-index", index);
    if (state.phase === "opening" && state.table.length > previousTableCount && index === state.table.length - 1) element.classList.add("newly-dealt");
    tableCards.appendChild(element);
  });
  $("emptyTable").classList.toggle("hidden", Boolean(state.table.length));
}

function renderHand() {
  const playerHand = $("playerHand");
  const signature = state.hand.map((card) => card.id).join(",");
  playerHand.classList.toggle("disabled", state.turn !== state.seat || state.phase !== "playing" || playing);
  if (playerHand.dataset.signature === signature) return;
  playerHand.dataset.signature = signature;
  playerHand.innerHTML = "";
  state.hand.forEach((card) => playerHand.appendChild(renderCard(card, true)));
}

function renderCard(card, playable = false) {
  const button = document.createElement(playable ? "button" : "span");
  button.className = "card";
  button.style.backgroundImage = `url("${cardImage(card)}")`;
  button.setAttribute("aria-label", card.suit === "joker" ? `${card.variant} joker` : `${card.rank} of ${card.suit}`);
  if (playable) button.addEventListener("click", () => playOnlineCard(card.id));
  return button;
}

function playCardAnimation(origin, card) {
  return new Promise((resolve) => {
    const flyingCard = document.createElement("div");
    flyingCard.className = `flying-card ${origin === "player" ? "from-player" : "from-opponent"}`;
    flyingCard.style.backgroundImage = `url("${cardImage(card)}")`;
    $("fxLayer").appendChild(flyingCard);
    setTimeout(() => {
      const impact = document.createElement("div");
      impact.className = "landing-impact";
      $("fxLayer").appendChild(impact);
      setTimeout(() => impact.remove(), 500);
    }, 300);
    setTimeout(() => { flyingCard.remove(); resolve(); }, 440);
  });
}

function playCaptureEffect(side, amount, isSweep) {
  const fx = document.createElement("div");
  fx.className = `pixel-fx ${isSweep ? "sweep-fx" : "capture-fx"}`;
  fx.innerHTML = isSweep ? `<strong>SWEEP!</strong><small>+2 POINTS</small>` : "";
  $("fxLayer").appendChild(fx);
  const badge = document.querySelector(`.capture-badge[data-side="${side}"]`);
  if (badge) {
    badge.classList.remove("count-pop");
    void badge.offsetWidth;
    badge.classList.add("count-pop");
    const gain = document.createElement("span");
    gain.className = "capture-gain";
    gain.textContent = `+${amount}`;
    badge.appendChild(gain);
    setTimeout(() => gain.remove(), 950);
  }
  setTimeout(() => fx.remove(), isSweep ? 1250 : 700);
}

function showRoundResults(points) {
  if ($("roundDialog").open) return;
  $("roundResultTitle").textContent = state.gameOver ? "Match complete" : "Round scored";
  $("roundResults").innerHTML = points.map((point, side) => {
    const name = state.mode === "2v2" ? `Team ${side + 1}` : state.players.find((player) => player.team === side)?.name || `Player ${side + 1}`;
    return `<div class="result-row"><span>${escapeHtml(name)} · ${state.capturedCounts[side]} cards · ${state.sweeps[side]} Sweeps</span><b>+${point}</b></div>`;
  }).join("");
  $("nextRound").textContent = state.gameOver ? "Back to lobby" : "Next round";
  $("roundDialog").showModal();
}

function showSurrenderResult() {
  if ($("roundDialog").open) return;
  const mySide = state.players[state.seat].team;
  $("roundResultTitle").textContent = state.surrenderedSide === mySide ? "You surrendered" : "Victory by surrender";
  $("roundResults").innerHTML = `<div class="result-row"><span>The match has ended.</span><b>${state.surrenderedSide === mySide ? "LOSS" : "WIN"}</b></div>`;
  $("nextRound").textContent = "Back to lobby";
  $("roundDialog").showModal();
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(el.timer);
  el.timer = setTimeout(() => el.classList.remove("show"), 1700);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function clearRoomSession() {
  clearInterval(pollTimer);
  pollTimer = null;
  session = null;
  state = null;
  sessionStorage.removeItem("sweep-session");
  showScreen("lobby");
}

async function leaveRoom() {
  const leavingSession = session;
  const wasWaiting = state?.phase === "waiting";
  clearRoomSession();
  if (!leavingSession || !wasWaiting) return;
  try {
    await api(`/api/rooms/${leavingSession.code}/leave`, {
      method: "POST",
      body: JSON.stringify({ token: leavingSession.token }),
      keepalive: true
    });
  } catch {
    // The local session is already cleared; the server will reject stale tokens.
  }
}

document.querySelectorAll("[data-open-panel]").forEach((button) => button.addEventListener("click", () => {
  panelMode = button.dataset.openPanel;
  const joining = panelMode === "join";
  $("panelEyebrow").textContent = joining ? "FIND YOUR TABLE" : "NEW TABLE";
  $("panelTitle").textContent = joining ? "Join room" : "Create room";
  $("panelCopy").textContent = joining ? "Enter the code shared by your host." : "Tap a mode to create its waiting room.";
  $("roomCodeField").classList.toggle("hidden", !joining);
  $("teamField").classList.toggle("hidden", !joining);
  $("scoreField").classList.toggle("hidden", joining);
  $("modeField").classList.toggle("hidden", joining);
  $("roomSubmit").textContent = joining ? "Join table" : "Create table";
  $("roomSubmit").classList.toggle("hidden", !joining);
  showScreen("roomPanel");
}));

$("backToLobby").addEventListener("click", () => showScreen("lobby"));
$("quickPlay").addEventListener("click", () => createOnlineRoom("Player", "1v1", 21, true).catch((error) => toast(error.message)));
$("roomForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("playerName").value.trim() || "Player";
  try {
    if (panelMode === "join") await joinOnlineRoom(name, $("roomCode").value, Number($("joinTeam").value));
    else await createOnlineRoom(name, $("selectedMode").value, $("targetScore").value);
  } catch (error) {
    toast(error.message);
  }
});
$("leaveWaitingButton").addEventListener("click", leaveRoom);
$("addBotButton").addEventListener("click", async () => {
  if (!session || !state?.isHost || state.phase !== "waiting") return;
  try {
    state = await api(`/api/rooms/${session.code}/add-bot`, {
      method: "POST", body: JSON.stringify({ token: session.token })
    });
    render();
  } catch (error) {
    toast(error.message);
  }
});
$("startRoomButton").addEventListener("click", async () => {
  if (!session || !state?.isHost || state.phase !== "waiting") return;
  try {
    state = await api(`/api/rooms/${session.code}/start`, {
      method: "POST", body: JSON.stringify({ token: session.token })
    });
    render();
  } catch (error) {
    toast(error.message);
  }
});
$("surrenderButton").addEventListener("click", () => {
  if (!session || !state || !["opening", "playing"].includes(state.phase)) return;
  $("surrenderDialog").showModal();
});
$("cancelSurrender").addEventListener("click", () => $("surrenderDialog").close());
$("confirmSurrender").addEventListener("click", async () => {
  $("surrenderDialog").close();
  try {
    state = await api(`/api/rooms/${session.code}/surrender`, {
      method: "POST", body: JSON.stringify({ token: session.token })
    });
    render();
    showSurrenderResult();
  } catch (error) {
    toast(error.message);
  }
});
document.querySelectorAll(".mode-option").forEach((option) => option.addEventListener("click", () => {
  document.querySelectorAll(".mode-option").forEach((button) => button.classList.toggle("selected", button === option));
  $("selectedMode").value = option.dataset.mode;
  const name = $("playerName").value.trim() || "Player";
  createOnlineRoom(name, option.dataset.mode, $("targetScore").value).catch((error) => {
    toast(error.message);
  });
}));
$("rulesButton").addEventListener("click", () => $("rulesDialog").showModal());
$("closeRules").addEventListener("click", () => $("rulesDialog").close());
$("nextRound").addEventListener("click", async () => {
  $("roundDialog").close();
  if (state.gameOver) return leaveRoom();
  try {
    state = await api(`/api/rooms/${session.code}/next-round`, {
      method: "POST", body: JSON.stringify({ token: session.token })
    });
    render();
  } catch (error) {
    toast(error.message);
  }
});

try {
  const savedSession = JSON.parse(sessionStorage.getItem("sweep-session"));
  if (savedSession?.code && savedSession?.token) enterRoom(savedSession);
} catch {
  sessionStorage.removeItem("sweep-session");
}

window.addEventListener("pagehide", () => {
  if (!session || state?.phase !== "waiting") return;
  const payload = new Blob([JSON.stringify({ token: session.token })], { type: "application/json" });
  navigator.sendBeacon(`/api/rooms/${session.code}/leave`, payload);
});
