# Hosting a world for free

The server is one Node process per world. It needs a way for browsers to reach it over a WebSocket, and because
the game page is served over HTTPS, browsers insist that the WebSocket is encrypted too (`wss://`). That last
point decides most of what follows.

The client is a single static file and can live on GitHub Pages at no cost.

## 1. In the browser tab

Open the page. The server's core runs in a worker inside the tab, with 63 bots. Nothing to host, no account.
One player. This is also how everything gets tested.

## 2. Your own PC, behind a Cloudflare quick tunnel

For playing with friends tonight.

```sh
npm install
npm start                                         # the world, on port 8080
cloudflared tunnel --url http://localhost:8080    # in a second terminal
```

`cloudflared` prints an address like `https://random-words.trycloudflare.com`. Friends open the game page with
`?server=wss://random-words.trycloudflare.com` on the end, or paste that address into the title card.

What Cloudflare's documentation says about quick tunnels: no account or domain needed, no uptime guarantee, at
most 200 requests in flight at once, no Server-Sent Events, and the address changes every time you start one.
A 64-player world holds 64 connections open, well under 200.

**Not yet tested.** Cloudflare's page does not mention WebSockets either way. Tunnels in general carry them, but
I could not reach Cloudflare from the build sandbox to confirm it for quick tunnels. It is a two-minute test on
your machine: start both commands, open the page with the `?server=` address, and see whether you walk in.

Your PC has real processor cores, so this option can carry a full 64-player world. It lasts as long as the PC
is on and the two commands are running.

## 3. Render's free instance

For a world that is reachable without your PC. `render.yaml` in this repository describes the service: connect
the repository in Render's dashboard as a Blueprint and it builds and starts. The address is
`wss://<name>.onrender.com`, with encryption handled by Render.

What you get, from Render's documentation: 0.1 of a CPU and 512 MB of memory, 750 instance hours a month, no
card needed. A free service is stopped after 15 minutes without an incoming request or WebSocket message, and
takes about a minute to wake when someone next connects. Since February 2026 an open game connection counts as
activity, so a world stays up while anyone is in it, and is empty when it sleeps.

**How many players it can carry.** In the load test the server used 7.5% of one 2.1 GHz core for 64 players,
almost all of it sending and receiving packets. A tenth of a CPU is about 10% of a core, so 64 players would sit
at three quarters of the allowance with nothing left for a busy moment, and a service that hits its allowance is
paused until the next slice of time, which players feel as a freeze. Around 30 players leaves a comfortable
margin today. That number will fall as later phases add things the server must simulate. Treat the free instance
as a place for small test sessions, not as the home of a full world. It has not been deployed yet.

## 4. Oracle Cloud Always Free

For a full world that stays up. Oracle's free allowance includes an Arm machine with 2 cores and 12 GB of
memory and 10 TB of traffic a month. A card is asked for to confirm identity, and free capacity is sometimes
unavailable in a region for days.

The machine has no encryption in front of it, so it needs a hostname and a certificate: a free DuckDNS name and
Caddy (which fetches certificates by itself) is the usual free pairing. This route has not been set up or tested.

## What does not work

- Fly.io has no free allowance for new accounts.
- Koyeb removed its card-free plan in February 2026.
- Railway's free plan is $1 of credit a month, which is a few days of a small server.
- Hugging Face Docker Spaces have needed a paid plan since July 2026.
- Serverless platforms (Vercel, Netlify, Cloudflare Workers without Durable Objects) cannot hold a world in
  memory between requests.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 8080 | Port to listen on. Hosts such as Render set it for you. |
| `BOTS` | 63 | Bots to keep in the world. They step aside as people join. |
| `MAX_PLAYERS` | 64 | People and bots together. |
| `ORIGINS` | any | Comma-separated list of page addresses allowed to connect, for example `https://you.github.io`. |

`/health` answers `ok`. `/status` returns the world's vital signs as JSON: players, tick timings, bytes a second.
