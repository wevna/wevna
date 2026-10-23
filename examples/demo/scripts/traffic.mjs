#!/usr/bin/env node
// A scripted 30 seconds of traffic for recording the demo. It does not need to be
// run exactly once: run it as often as you like, and set DEMO_SPEED=0.2 to play it
// at five times speed while rehearsing.
//
//   pnpm --filter @wevna/example-demo traffic
const STOREFRONT = `http://localhost:${process.env.STOREFRONT_PORT ?? 3001}`;
const PRICING = `http://localhost:${process.env.PRICING_PORT ?? 3002}`;
const SPEED = Number(process.env.DEMO_SPEED ?? 1);

const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1).padStart(4);
const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000 * SPEED));

async function hit(label, url) {
  const began = Date.now();
  let status = "ERR";
  try {
    const response = await fetch(url);
    status = String(response.status);
    await response.arrayBuffer();
  } catch {
    // reported below
  }
  console.log(`t=${elapsed()}s  ${label.padEnd(34)} ${status}  ${Date.now() - began}ms`);
  return status;
}

// Each step names what the audience should be looking at.
console.log("Demo traffic. Starts quiet, then:");
console.log("  orders (an N+1 in both services) -> a slow report -> a failure -> orders\n");

// 0 to 4 seconds: quiet. A couple of health checks so the dashboards show a pulse.
await hit("health  storefront", `${STOREFRONT}/health`);
await hit("health  pricing", `${PRICING}/health`);
await sleep(2.5);

// 4 to 14 seconds: orders. Each one is an N+1 in the Node service, then a call to
// Python, which does its own N+1 and calls back. Open one in either dashboard.
for (const id of [1, 2, 3, 4, 5, 6]) {
  await hit(`order ${id}  (N+1 in both services)`, `${STOREFRONT}/orders/${id}`);
  await sleep(1.4);
}

// 14 to 19 seconds: the slow endpoint. Look at the Performance tab: one query
// accounts for almost the whole request.
await hit("daily report  (slow query)", `${STOREFRONT}/reports/daily`);
await sleep(1.2);
await hit("daily report  (slow query)", `${STOREFRONT}/reports/daily`);
await sleep(2);

// 19 to 23 seconds: failures. The Node one throws inside a handler; the Python one
// is refused by the handler. Both show up with their exception attached.
await hit("boom  (storefront throws)", `${STOREFRONT}/boom`);
await sleep(1.5);
await hit("quote 0  (pricing raises)", `${PRICING}/quote/0`);
await sleep(2);

// 23 to 30 seconds: back to normal orders, so the recording does not end on an error.
for (const id of [2, 4, 6]) {
  await hit(`order ${id}  (N+1 in both services)`, `${STOREFRONT}/orders/${id}`);
  await sleep(1.6);
}

console.log(`\nDone in ${elapsed()}s.`);
