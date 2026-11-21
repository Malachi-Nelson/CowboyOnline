# Wire protocol, version 3

Everything travels as binary WebSocket messages. The first byte is the message type. Numbers are little-endian.
`shared/net/messages.js` is the implementation; change both together and raise `PROTOCOL_VERSION` in
`shared/constants.js`. A client and server with different versions refuse each other at the hello.

Types used below: `u8 u16 u24 u32` unsigned, `i8 i16` signed, `f32 f64` floats, `str` one length byte then up to
255 bytes of UTF-8, `vari` a zigzag varint (values from -64 to 63 take one byte).

What changed from version 2 (Phase 4): inputs carry the view's pitch and 16-bit buttons (aim, fire, reload, focus,
hands up, and which gun is wanted in hand), and packets end with hints for the shots in them; your own state can
carry a gun block; snapshots carry your status (health, the law) when it changes and the events you could see
(shots, hits, deaths, notes); other people carry a gear byte (gun in hand, aiming, reloading, hands up, dead,
witness, wanted), and a lawman is marked in the entity flags.

Version 2 (Phase 3) gave every player a horse in their own state, horses as entities that say whose they are, the
use and whistle buttons, and the time of day in the welcome and the pong.

## Client to server

| Type | Name | Layout |
|---|---|---|
| 1 | HELLO | `u16 protocol`, `str name`, `str token` (empty on a first visit) |
| 3 | INPUT | `u16 firstSeq`, `u16 viewMs`, `u8 count` (at most 12), then `count` inputs |
| 5 | PING | `f64 clientTime` |

One input is 8 bytes: `i8 strafe`, `i8 forward` (each -127 to 127), `u16 viewYaw` (65,536 steps to a full turn),
`i16 viewPitch` (the same steps, up is positive, held to about 77 degrees either way), `u16 buttons`:

```
1 sprint (gallop in the saddle)   2 jump      4 walk (trot in the saddle)   8 use (mount, dismount)   16 whistle
32 aim     64 fire     128 reload     256 focus (Iron Nerve)     512 hands up
bits 10-11: the gun wanted in hand: 0 none, 1 revolver, 2 repeater, 3 whatever is in hand now
```

Use, whistle, jump in the saddle, fire and reload act when the button goes down, not while it is held. Each input
is worth exactly 1/60 s and has a 16-bit sequence number that wraps; the inputs in a packet are consecutive from
`firstSeq`. After the inputs comes `u8 nHints` and that many hints of 6 bytes, `u16 seq`, `u16 targetId`,
`u16 targetMs`: for a shot fired in input `seq`, who was under the sights and the server time (ms, 16 bits) at
which the shooter's screen showed them there. The client sends three inputs in a packet, 20 packets a second: 37
bytes on the wire each without hints, about 0.75 KB/s. More hints than inputs closes the connection.

`viewMs` is the server time, in milliseconds and cut to 16 bits, of the world the player was looking at when the
newest of those inputs was made (others nearby are drawn about this far in the past). The server judges a shot
against everyone as they were at that moment, or for the hinted target at its own moment, but never further back
than 400 ms. A client never says what it hit.

## Server to client

| Type | Name | Layout |
|---|---|---|
| 2 | WELCOME | `u16 protocol`, `u16 yourId`, `u8 tickRate`, `u32 tick`, `f64 serverNow`, `u32 dayMs`, `u32 worldSeed`, `str token`, `u16 yourHorseId`, then your state (below), always with the horse |
| 4 | SNAPSHOT | see below |
| 6 | PONG | `f64 clientTime` (echoed), `f64 serverNow`, `u32 dayMs` |
| 7 | REJECT | `u8 code` (1 wrong version, 2 world full, 3 bad message), `str text` to show the player |

The token in WELCOME is a secret for this player in this world. Sending it back in a later HELLO, within 30
seconds of dropping, returns the same body, and the same horse, where they were left.

`dayMs` is how far into the day the world is, from midnight, in milliseconds of a 48-minute day. With `serverNow`
it lets the client keep the clock itself.

### Your own state

The player's own state is sent in full precision, because the client replays its inputs from it. It is the same
in the welcome and in every snapshot.

```
f32 x y z, f32 vx vy vz    your body (in the saddle, the same as the horse)
u8  flags                  1 on the ground, 2 jump held, 4 in the saddle, 8 use held, 16 whistle held,
                           32 you have a horse, 64 the horse block follows, 128 the gun block follows
u8  whistle                steps until you can whistle again (90 after a whistle)
[horse block, 40 bytes]    f32 x y z, f32 headingX headingZ, f32 speed, f32 vy, f32 wind (0..1), f32 distance to you when last checked,
                           u8 flags (1 on the ground, 2 winded, 4..12 mode: 0 standing, 1 coming to you),
                           u16 steps since called, u8 steps since last checked for being stuck
[gun block, 24 bytes]      u8 gun in hand, u8 steps left drawing or putting away, u8 gun being drawn, u8 steps until the
                           next shot, u8 steps until the next round is in, u8 rounds in the revolver, u8 rounds in the
                           repeater, u16 spare revolver rounds, u16 spare repeater rounds, u16 shots fired (the spread's
                           seed), u8 steps spent aiming, u8 flags (1 fire held, 2 reload held, 4 in Iron Nerve, 8 hands
                           up), u8 (1 dead, 2 in jail), f32 extra spread from recent shots, f32 Iron Nerve meter (0..1)
```

26 bytes, 66 with the horse, 24 more with the guns. The server sends either block whenever anything in it has
changed since it last sent it: the horse while it is ridden or called, the guns while they are drawn, fired,
reloaded or aimed. A horse standing still and a gun in its holster cost nothing. Dead and in jail are in the gun
block because they change what the shared step does; the server sets them, so being killed or locked up is one
correction for the player's prediction.

### SNAPSHOT

Sent to each player once per tick, 20 a second. Never more than 796 bytes, which with the frame header is 16 KB/s
at the very most.

```
u32 tick
u16 ackSeq                 the last of your inputs the server has applied
your state                 as above, after that input
u8  status follows?        1 if it has changed since it was last sent, then:
                           u8 health, u8 flags (1 dead, 2 jailed, 4 a lawman sees you, 8 surrendering),
                           u8 wanted (0 no, 1 reported, 2 seen, 3 a posse is out), u16 bounty ($),
                           u16 searchX, u16 searchZ (m), u8 searchRadius (4 m), u8 seconds left (getting up, or jail),
                           u8 witnesses on their way to the law
u8  nEvents, then events   (below)
u8  nGone,  then nGone  x  u16 id
u8  nSpawn, then nSpawn x  { u16 id, u8 kind, u8 flags (1 bot, 2 lawman), str name, u24 x, u24 z, u16 y, u8 yaw,
                             u8 state, u8 gear, [u16 owner, for a horse] }
u8  nUpdate, then nUpdate x { u16 id, u8 mask, [u8 hold], [vari dx, vari dz, vari dy], [u8 yaw], [u8 state], [u8 gear] }
```

Events, each `u8 type` then:

```
1 SHOT   u16 shooter, u8 gun, u16 yaw, i16 pitch, u16 how far it went (dm), u8 what it struck
         (0 nothing, 1 ground, 2 a building or fence, 3 a tree, 4 water, 5 someone, 6 a horse)       11 bytes
2 HIT    u16 who, u16 by whom, u8 where (1 head, 2 body, 3 legs, 4 a horse), u8 damage, u16 the shot's yaw,
         u8 health left                                                                                10 bytes
3 DIE    u16 who, u16 by whom, u8 where                                                                6 bytes
4 NOTE   u8 what (1 seen, 2 witnesses on their way, 3 reported, 4 wanted, 5 got away, 6 arrested, 7 released,
         8 a lawman sees you, 9 out of sight, 11 a posse is out), u16 a number to go with it            4 bytes
```

A shot is told to everyone who can see the shooter, a hit or a death to everyone who can see either side. The
shot's line starts beside the shooter's head on the camera's line (head height 1.55 m on foot and 2.45 m in the
saddle, plus 0.15 m, and 0.72 m or 0.8 m to the right), so a viewer can draw it from the same place. At most a
third of the snapshot budget goes on events; any left over wait for the next snapshot.

`kind` is 1 for a person, 2 for a horse. A player is never sent their own horse this way: it is part of their own
state.

Positions of other entities are whole numbers: x and z in 1/32 m, y in 1/16 m offset by 64 m, yaw in 256 steps.
`state` bits: 1 on the ground, 2 sprinting (for a horse, galloping), 4 moving, 8 in the saddle, 16 whistling.
`gear` bits: 0-1 the gun in hand, 4 aiming, 8 reloading, 16 hands up, 32 dead, 64 a witness on their way to the
law, 128 wanted. An update's `mask` says which fields follow: 1 position (as the change since the last value this
player was sent), 2 yaw, 4 state, 8 gear, 16 put, 128 hold. Someone aiming faces the way they aim, and a rider
aiming sends that as their own yaw.

A person in the saddle sends no position of their own: the viewer draws them on the horse that names them as its
owner. When they step down, one update moves them from where they mounted to where they now stand, and the viewer
puts them there at once rather than drawing them sliding. The same goes for a horse brought in by a whistle from
far away: an update that moves something more than 20 m is a move, not a journey. When the server itself puts a
body somewhere (getting up again after being shot, the cell, out of it), the update says so with `put`, which
carries no bytes of its own, so even a short move is shown as one. A viewer who has not been sent anything about
that body since is told on the next update it gets, however late that is.

`hold` covers one case. A body that has been standing still sends nothing. When it sets off, a player who hears
about it a few ticks late would otherwise draw it sliding from its resting place over that whole gap. `hold` is
the number of ticks ago it was still at rest, so the viewer can keep it there until then.

An entity is spawned when it comes within 384 m and listed in `nGone` when it passes 448 m. Between the two it
stays as it was. Something that has not changed is not mentioned, and costs nothing.

Not everything in view is updated every tick. Each entity earns priority every tick, faster the nearer it is:
within 60 m it is due every tick (20 a second), within 150 m every other tick, within 400 m every fourth, beyond
that every tenth. Whatever is due and has changed is written, most overdue first, until the budget is spent.
What does not fit keeps its priority and goes first next time.

## Cost, as measured (Phase 4, 64 players, two in three of them riding)

| Situation | Down, per player | Up, per player |
|---|---|---|
| Scattered over the map | 1.3 KB/s (2.0 KB in the worst second) | 0.76 KB/s |
| In and around Calder's Landing: everyone and their horses in view | 6.5 KB/s (8.4 KB) | 0.76 KB/s |
| Everyone and their horses within 30 m of one spot | 9.0 KB/s (10.2 KB) | 0.76 KB/s |
| Everyone in the middle of town shooting at each other, with the law after them | 8.5 KB/s (10.6 KB) | 0.76 KB/s |

A moving body costs 6 to 8 bytes per update; a ridden horse the same, and its rider nothing. Inputs cost a third
more than in Phase 3 (pitch and 16-bit buttons). A shot costs 11 bytes to each player who can see the shooter.
