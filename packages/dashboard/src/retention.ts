// How much live history the dashboard keeps in memory.
//
// Both stores were previously unbounded, which is fine for a demo and wrong
// for the way Wevna is actually used: a local dashboard left open against a
// chatty application all day accumulates every event it ever saw until the
// tab becomes unusable. A local-first tool has no server-side retention to
// fall back on, so the bound has to live here.
//
// These are not tuning knobs for throughput — they are the point past which
// old history stops being worth its memory. Anything older is still
// recoverable from a recording, which is what recordings are for.

// Live events retained, newest-first eviction. 10,000 is roughly a busy
// morning's traffic, comfortably scrollable, and small enough that the whole
// list stays cheap to snapshot.
export const MAX_LIVE_EVENTS = 10_000;

// Requests retained. Deliberately capped as well, and not only for its own
// sake: a RequestModel holds references to its own events, so evicting from
// the event list alone would not actually release those events while a
// request still pointed at them. Capping requests is what makes the event
// cap real.
//
// 1,000 rather than 10,000 because a request is the unit a developer
// navigates, and a list longer than this is not something anyone scrolls —
// they search or record instead.
export const MAX_LIVE_REQUESTS = 1_000;
