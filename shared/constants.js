// Numbers both sides must agree on. Change PROTOCOL_VERSION whenever anything on the wire changes.
export const PROTOCOL_VERSION = 1;

// Time. The world ticks 20 times a second; a player's own movement runs 60 steps a second, one per input.
export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;
export const SIM_RATE = 60;
export const SIM_DT = 1 / SIM_RATE;
export const CMDS_PER_TICK = SIM_RATE / TICK_RATE;

// Space. One square world; the interest grid uses the same squares the terrain chunks will.
export const WORLD_SIZE = 4096;
export const CHUNK = 128;
export const GRID_N = WORLD_SIZE / CHUNK;
export const HUB_X = 2048;
export const HUB_Z = 2048;

// Interest management: an entity enters a player's view inside VIEW_ENTER and leaves beyond VIEW_LEAVE.
export const VIEW_ENTER = 384;
export const VIEW_LEAVE = 448;
// Priority bands: within NEAR an entity is due every tick, then every 2nd, every 4th, every 10th.
export const BAND_NEAR = 60;
export const BAND_MID = 150;
export const BAND_FAR = 400;

// Bandwidth. 796 bytes of payload plus a 4-byte WebSocket frame header is 800 bytes, 20 times a second: 16 KB/s.
export const SNAPSHOT_BUDGET = 796;
export const MAX_PLAYERS = 64;

// Quantisation of remote entities: 1/32 m across the ground, 1/16 m in height.
export const POS_Q = 32;
export const Y_Q = 16;
export const Y_OFF = 64;

export const KIND_PLAYER = 1;
export const EF_BOT = 1;          // entity flag: driven by the server, not a person
export const ST_GROUND = 1;       // entity state bits, as other players see them
export const ST_SPRINT = 2;
export const ST_MOVE = 4;                    // moving over the ground; a viewer may carry it forward a moment if an update is late
