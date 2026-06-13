const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 4180);
const ROOT = __dirname;
const rooms = new Map();
const MODE_SEATS = { "1v1": 2, "1v1v1": 3, "2v2": 4 };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };

function code() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function token() {
  return crypto.randomBytes(18).toString("hex");
}

function makeDeck() {
  let id = 0;
  const cards = ["spades", "hearts", "diamonds", "clubs"].flatMap((suit) =>
    Array.from({ length: 13 }, (_, i) => ({ id: `${suit}-${i + 1}-${id++}`, suit, rank: i + 1 }))
  );
  cards.push({ id: `joker-clubs-${id++}`, suit: "joker", rank: 0, variant: "Clubs" });
  cards.push({ id: `joker-spades-${id++}`, suit: "joker", rank: 0, variant: "Spades" });
  return shuffle(cards);
}

function shuffle(cards) {
  const copy = [...cards];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function sideFor(room, seat) {
  return room.mode === "2v2" ? seat % 2 : seat;
}

function sideCount(room) {
  return room.mode === "2v2" ? 2 : room.maxPlayers;
}

function createRoom(name, mode, target = 21, quick = false) {
  const roomCode = code();
  const hostToken = token();
  const room = {
    code: roomCode, mode, target: Number(target) || 21, maxPlayers: MODE_SEATS[mode],
    hostToken, botCount: 0,
    players: [{ name: cleanName(name), token: hostToken, connectedAt: Date.now(), bot: false }],
    phase: "waiting", round: 0, scores: [], sweeps: [], captured: [], hands: [], deck: [], table: [],
    openingCards: [], openingStartedAt: 0, turn: 0, lastCaptureSide: null, surrenderedSide: null, eventId: 0, event: null,
    nextBotAt: 0, gameOver: false
  };
  if (quick) room.players.push({ name: "Dealer", token: token(), connectedAt: Date.now(), bot: true });
  rooms.set(roomCode, room);
  if (room.players.length === room.maxPlayers) startMatch(room);
  return { room, token: hostToken, seat: 0 };
}

function cleanName(name) {
  return String(name || "Player").trim().slice(0, 16) || "Player";
}

function startMatch(room) {
  room.round = 1;
  room.scores = Array(sideCount(room)).fill(0);
  startRound(room);
}

function startRound(room) {
  room.deck = makeDeck();
  room.hands = room.players.map(() => []);
  room.table = [];
  room.captured = Array.from({ length: sideCount(room) }, () => []);
  room.sweeps = Array(sideCount(room)).fill(0);
  room.lastCaptureSide = null;
  room.surrenderedSide = null;
  room.turn = Math.floor(Math.random() * room.players.length);
  room.phase = "opening";
  room.gameOver = false;
  dealHands(room);
  room.openingCards = Array.from({ length: 4 }, () => room.deck.pop());
  room.openingStartedAt = Date.now();
  room.nextBotAt = 0;
  emit(room, { type: "round-start" });
}

function dealHands(room) {
  for (let i = 0; i < 4; i++) {
    for (const hand of room.hands) if (room.deck.length) hand.push(room.deck.pop());
  }
}

function tick(room) {
  if (room.phase === "opening") {
    const reveal = Math.min(4, Math.floor((Date.now() - room.openingStartedAt) / 1200));
    while (room.table.length < reveal) room.table.push(room.openingCards[room.table.length]);
    if (room.table.length === 4) {
      room.phase = "playing";
      room.nextBotAt = Date.now() + 900;
    }
  }
  if (room.phase === "playing" && room.players[room.turn]?.bot && Date.now() >= room.nextBotAt) {
    room.nextBotAt = Infinity;
    botPlay(room);
  }
}

function play(room, seat, cardId) {
  tick(room);
  if (room.phase !== "playing") throw new Error("The round is not ready");
  if (room.turn !== seat) throw new Error("It is not your turn");
  const index = room.hands[seat].findIndex((card) => card.id === cardId);
  if (index < 0) throw new Error("Card is not in your hand");
  const [played] = room.hands[seat].splice(index, 1);
  const top = room.table.at(-1);
  const capture = top && (played.suit === "joker" || played.rank === top.rank);
  const side = sideFor(room, seat);
  let capturedCount = 0;
  let sweep = false;

  if (capture) {
    const pile = [...room.table];
    sweep = pile.length === 1;
    room.table = [];
    room.captured[side].push(played, ...pile);
    room.lastCaptureSide = side;
    capturedCount = pile.length + 1;
    if (sweep) room.sweeps[side]++;
  } else {
    room.table.push(played);
  }

  emit(room, { type: "play", seat, card: played, capture, capturedCount, sweep });
  if (room.hands.every((hand) => hand.length === 0)) {
    if (room.deck.length) dealHands(room);
    else return finishRound(room);
  }
  room.turn = nextSeatWithCards(room, room.turn);
  if (room.turn === null) return finishRound(room);
  room.nextBotAt = Date.now() + 900;
}

function nextSeatWithCards(room, fromSeat) {
  for (let offset = 1; offset <= room.players.length; offset++) {
    const seat = (fromSeat + offset) % room.players.length;
    if (room.hands[seat]?.length) return seat;
  }
  return null;
}

function botPlay(room) {
  const hand = room.hands[room.turn];
  if (!hand?.length) {
    room.turn = nextSeatWithCards(room, room.turn);
    if (room.turn === null) return finishRound(room);
    room.nextBotAt = Date.now() + 250;
    return;
  }
  const top = room.table.at(-1);
  const playable = hand.filter((card) => card.suit === "joker" || card.rank === top?.rank);
  const card = playable.length ? playable[Math.floor(Math.random() * playable.length)] : hand[Math.floor(Math.random() * hand.length)];
  if (card) play(room, room.turn, card.id);
}

function finishRound(room) {
  if (room.table.length && room.lastCaptureSide !== null) room.captured[room.lastCaptureSide].push(...room.table);
  room.table = [];
  const points = room.sweeps.map((count) => count * 2);
  const counts = room.captured.map((pile) => pile.length);
  const highest = Math.max(...counts);
  if (counts.filter((count) => count === highest).length === 1) points[counts.indexOf(highest)] += 3;
  room.captured.forEach((pile, side) => {
    if (pile.some((card) => card.suit === "diamonds" && card.rank === 10)) points[side] += 2;
    if (pile.some((card) => card.suit === "clubs" && card.rank === 2)) points[side] += 1;
  });
  points.forEach((point, side) => room.scores[side] += point);
  room.gameOver = room.scores.some((score) => score >= room.target);
  room.phase = room.gameOver ? "game-over" : "round-end";
  emit(room, { type: "round-end", points });
}

function emit(room, event) {
  room.eventId++;
  room.event = { ...event, id: room.eventId, at: Date.now() };
}

function publicState(room, seat) {
  tick(room);
  const mySide = sideFor(room, seat);
  return {
    code: room.code, mode: room.mode, target: room.target, maxPlayers: room.maxPlayers, phase: room.phase,
    round: room.round, seat, mySide, isHost: room.players[seat].token === room.hostToken, turn: room.turn, deckCount: room.deck.length, table: room.table,
    players: room.players.map((player, playerSeat) => ({
      seat: playerSeat, name: player.name, team: sideFor(room, playerSeat), handCount: room.hands[playerSeat]?.length || 0,
      capturedCount: room.captured[sideFor(room, playerSeat)]?.length || 0, sweeps: room.sweeps[sideFor(room, playerSeat)] || 0,
      score: room.scores[sideFor(room, playerSeat)] || 0, bot: player.bot
    })),
    hand: room.hands[seat] || [], scores: room.scores, sweeps: room.sweeps,
    capturedCounts: room.captured.map((pile) => pile.length), event: room.event, gameOver: room.gameOver,
    surrenderedSide: room.surrenderedSide
  };
}

function auth(room, requestToken) {
  const seat = room.players.findIndex((player) => player.token === requestToken);
  if (seat < 0) throw new Error("Invalid player token");
  return seat;
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

async function api(req, res, url) {
  try {
    if (req.method === "POST" && url.pathname === "/api/rooms") {
      const data = await body(req);
      if (!MODE_SEATS[data.mode]) throw new Error("Invalid mode");
      const created = createRoom(data.name, data.mode, data.target, Boolean(data.quick));
      return json(res, 201, { code: created.room.code, token: created.token, seat: created.seat });
    }
    if (req.method === "POST" && /^\/api\/rooms\/[^/]+\/join$/.test(url.pathname)) {
      const roomCode = url.pathname.split("/")[3].toUpperCase();
      const room = rooms.get(roomCode);
      if (!room) throw new Error("Room not found");
      if (room.phase !== "waiting" || room.players.length >= room.maxPlayers) throw new Error("Room is full or already started");
      const data = await body(req);
      const playerToken = token();
      room.players.push({ name: cleanName(data.name), token: playerToken, connectedAt: Date.now(), bot: false });
      const seat = room.players.length - 1;
      if (room.players.length === room.maxPlayers) startMatch(room);
      return json(res, 200, { code: room.code, token: playerToken, seat });
    }
    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(state|play|next-round|surrender|add-bot)$/);
    if (match) {
      const room = rooms.get(match[1].toUpperCase());
      if (!room) throw new Error("Room not found");
      const data = req.method === "POST" ? await body(req) : {};
      const playerToken = url.searchParams.get("token") || data.token;
      const seat = auth(room, playerToken);
      if (match[2] === "state" && req.method === "GET") return json(res, 200, publicState(room, seat));
      if (match[2] === "play" && req.method === "POST") {
        play(room, seat, data.cardId);
        return json(res, 200, publicState(room, seat));
      }
      if (match[2] === "next-round" && req.method === "POST") {
        if (room.phase !== "round-end") throw new Error("Round is not complete");
        room.round++;
        startRound(room);
        return json(res, 200, publicState(room, seat));
      }
      if (match[2] === "surrender" && req.method === "POST") {
        if (!["opening", "playing"].includes(room.phase)) throw new Error("The match is not active");
        const surrenderedSide = sideFor(room, seat);
        room.surrenderedSide = surrenderedSide;
        room.gameOver = true;
        room.phase = "game-over";
        room.scores.forEach((score, side) => {
          if (side !== surrenderedSide) room.scores[side] = Math.max(score, room.target);
        });
        emit(room, { type: "surrender", seat, side: surrenderedSide });
        return json(res, 200, publicState(room, seat));
      }
      if (match[2] === "add-bot" && req.method === "POST") {
        if (room.players[seat].token !== room.hostToken) throw new Error("Only the host can add bots");
        if (room.phase !== "waiting" || room.players.length >= room.maxPlayers) throw new Error("No empty bot seats remain");
        room.botCount++;
        room.players.push({ name: `Bot ${room.botCount}`, token: token(), connectedAt: Date.now(), bot: true });
        if (room.players.length === room.maxPlayers) startMatch(room);
        return json(res, 200, publicState(room, seat));
      }
    }
    json(res, 404, { error: "Not found" });
  } catch (error) {
    json(res, 400, { error: error.message });
  }
}

function staticFile(req, res, url) {
  const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const file = path.resolve(ROOT, relative);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end("Not found");
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) return api(req, res, url);
  staticFile(req, res, url);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Close the other server or run: $env:PORT=4181; node server.js`);
    process.exitCode = 1;
    return;
  }
  throw error;
});

server.listen(PORT, "0.0.0.0", () => console.log(`Sweep multiplayer server running at http://localhost:${PORT}`));
