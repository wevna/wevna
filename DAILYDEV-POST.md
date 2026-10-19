# I got tired of reconstructing what my backend did from log lines, so I built a live dashboard for it

Every time something was slow in one of my Node APIs, I'd end up doing the
same thing: sprinkle `console.log`s everywhere, or `tail -f` the logs, then
manually piece together which query ran for which request and in what order.
Neither actually *shows* you what happened — you reconstruct it by hand,
every time.

So I built **Wevna**. One line — `await wevna.start()` — and it opens a local
dashboard that shows every HTTP request, SQL query, Redis command, and
console.log live, correlated back to the request it belongs to. You get a
waterfall per request, and it'll flag things like "this query ran 4 times for
one request" (the N+1 you didn't notice) without you having to go looking
for it.

It's local-first — nothing leaves your machine, no account, no cloud. Free,
MIT licensed.

```bash
npm install @wevna/sdk
```

If you want to see it before wiring it into anything, there's a runnable
example:

```bash
git clone https://github.com/wevna/wevna.git
cd wevna && pnpm install && pnpm build
pnpm --filter @wevna/example-express dev
```

GitHub: https://github.com/wevna/wevna

Would love feedback, especially from anyone who fights N+1s or slow endpoints
regularly — that's exactly the itch this scratches.
