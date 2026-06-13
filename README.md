# Sweep Online

Sweep is an authoritative multiplayer browser card game supporting:

- `1v1`
- `1v1v1` free-for-all
- `2v2` teams with alternating seats and shared team scores

## Run

```powershell
node server.js
```

Open `http://localhost:4180`.

Players on the same network can join using the host computer's LAN address and the room code shown in the waiting room.

For public internet play, deploy this folder to a Node.js host and run `node server.js`. The server binds to `0.0.0.0` and reads the optional `PORT` environment variable.

## Authority

The server owns and validates room capacity, private hands, turn order, captures, Sweeps, redeals, scoring, round endings, and team assignment. Rooms currently live in server memory and reset when the server restarts.
