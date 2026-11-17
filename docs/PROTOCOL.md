# Wire protocol, version 1

Everything travels as binary WebSocket messages. The first byte is the message type. Numbers are little-endian.
`shared/net/messages.js` is the implementation; change both together and raise `PROTOCOL_VERSION` in
`shared/constants.js`. A client and server with different versions refuse each other at the hello.

Types used below: `u8 u16 u24 u32` unsigned, `i8` signed, `f32 f64` floats, `str` one length byte then up to
255 bytes of UTF-8, `vari` a zigzag varint (values from -64 to 63 take one byte).

## Client to server

| Type | Name | Layout |
|---|---|---|
| 1 | HELLO | `u16 protocol`, `str name`, `str token` (empty on a first visit) |
| 3 | INPUT | `u16 firstSeq`, `u16 viewMs`, `u8 count` (at most 12), then `count` inputs |
| 5 | PING | `f64 clientTime` |

One input is 5 bytes: `i8 strafe`, `i8 forward` (each -127 to 127), `u16 viewYaw` (65,536 steps to a full turn),
`u8 buttons` (1 sprint, 2 jump, 4 walk). Each input is worth exactly 1/60 s of movement and has a 16-bit sequence
number that wraps; the inputs in a packet are consecutive from `firstSeq`. The client sends three inputs in a
packet, 20 packets a second: 27 bytes on the wire each, about 0.55 KB/s.

`viewMs` is the server time, in milliseconds and cut to 16 bits, of the world the player was looking at when the
newest of those inputs was made. Nothing uses it yet. From Phase 4 the server rewinds targets to that moment to
judge a shot.

## Server to client

| Type | Name | Layout |
|---|---|---|
| 2 | WELCOME | `u16 protocol`, `u16 yourId`, `u8 tickRate`, `u32 tick`, `f64 serverNow`, `u32 worldSeed`, `str token`, `f32 x y z` |
| 4 | SNAPSHOT | see below |
| 6 | PONG | `f64 clientTime` (echoed), `f64 serverNow` |
| 7 | REJECT | `u8 code` (1 wrong version, 2 world full, 3 bad message), `str text` to show the player |

The token in WELCOME is a secret for this player in this world. Sending it back in a later HELLO, within 30
seconds of dropping, returns the same body where it was left.

### SNAPSHOT

Sent to each player once per tick, 20 a second. Never more than 796 bytes, which with the frame header is 16 KB/s
at the very most.

```
u32 tick
u16 ackSeq                 the last of your inputs the server has applied
f32 x y z, f32 vx vy vz    your own body after that input, exactly as the server holds it
u8  flags                  1 on the ground, 2 jump still held
u8  nGone,  then nGone  x  u16 id
u8  nSpawn, then nSpawn x  { u16 id, u8 kind, u8 flags (1 bot), str name, u24 x, u24 z, u16 y, u8 yaw, u8 state }
u8  nUpdate, then nUpdate x { u16 id, u8 mask, [u8 hold], [vari dx, vari dz, vari dy], [u8 yaw], [u8 state] }
```

Positions of other entities are whole numbers: x and z in 1/32 m, y in 1/16 m offset by 64 m, yaw in 256 steps.
`state` bits: 1 on the ground, 2 sprinting, 4 moving. An update's `mask` says which fields follow: 1 position
(as the change since the last value this player was sent), 2 yaw, 4 state, 128 hold.

`hold` covers one case. A body that has been standing still sends nothing. When it sets off, a player who hears
about it a few ticks late would otherwise draw it sliding from its resting place over that whole gap. `hold` is
the number of ticks ago it was still at rest, so the viewer can keep it there until then.

An entity is spawned when it comes within 384 m and listed in `nGone` when it passes 448 m. Between the two it
stays as it was. Something that has not changed is not mentioned, and costs nothing.

Not everything in view is updated every tick. Each entity earns priority every tick, faster the nearer it is:
within 60 m it is due every tick (20 a second), within 150 m every other tick, within 400 m every fourth, beyond
that every tenth. Whatever is due and has changed is written, most overdue first, until the budget is spent.
What does not fit keeps its priority and goes first next time.

## Cost, as measured

| Situation | Down, per player | Up, per player |
|---|---|---|
| Alone, or a few riders in sight | 0.8 KB/s | 0.55 KB/s |
| A busy town: 63 others within 200 m | 5.0 KB/s | 0.55 KB/s |
| Everyone within 30 m (the worst case with 64 players) | 7.8 KB/s | 0.55 KB/s |

A moving body costs 6 to 8 bytes per update.
