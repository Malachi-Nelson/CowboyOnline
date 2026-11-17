// The one shared game-state store on the client. Every module reads the same object and is told when it changes.
// What lives here is what the player's own machine is entitled to decide: settings, which screen is up, what the
// controls are asking for. What the world is doing lives in the session, and the server decides that.
export function createStore(initial) {
  const state = { ...initial }, subs = new Set();
  return {
    state,
    get: k => state[k],
    set(patch) { let changed = false; for (const k in patch) if (state[k] !== patch[k]) { state[k] = patch[k]; changed = true; } if (changed) for (const f of subs) f(state, patch); },
    on(f) { subs.add(f); return () => subs.delete(f); },
  };
}

// small values a player expects to find again next visit. Storage can be missing or refuse; the game runs without it.
export const saved = {
  get(k, d) { try { const v = localStorage.getItem('cowboyonline.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('cowboyonline.' + k, JSON.stringify(v)); } catch (e) { /* not kept */ } },
};
