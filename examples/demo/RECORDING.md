# Recording the demo

A 30 second recording that shows two services, two languages and one idea: the
queries, the calls between services and the failures are all visible, per request,
without adding any logging.

## Before you record

1. A clean terminal and a wide window. Put the two dashboards **side by side**:
   Node on the left (<http://localhost:4123>), Python on the right
   (<http://localhost:4124>). Around 1600 pixels wide in total works well.
2. Use the dark theme (the sun and moon button, or press `T`). It reads better in a
   GIF.
3. Start the demo and let it settle:

   ```bash
   pnpm --filter @wevna/example-demo demo
   ```

   Wait for "Both services are up".
4. Rehearse once at five times speed, so the services are warm and you know the
   sequence:

   ```bash
   DEMO_SPEED=0.2 pnpm --filter @wevna/example-demo traffic
   ```

5. **Clear the requests in both dashboards** (the "Clear requests" button) so the
   recording starts from empty.
6. Close other tabs and notifications. Press `?` in a dashboard if you want to show
   the keyboard shortcuts at the end; otherwise leave it closed.

## The take

Start your screen recorder, then run:

```bash
pnpm --filter @wevna/example-demo traffic
```

It takes about 30 seconds. What happens, and where to look:

| Time | What the script does | What to show |
| --- | --- | --- |
| 0 to 4 s | Two health checks | Both dashboards wake up. Say nothing yet. |
| 4 to 14 s | Orders 1 to 6, one every 1.4 s | Requests appear in both dashboards. Press `J` to step through them. In the Node dashboard open an order: the **Repeated Query** insight on the N+1. Then the same order in the Python dashboard. |
| 14 to 19 s | The slow report, twice | Open it and go to the **Performance** tab: one query is almost the whole request. |
| 19 to 23 s | `/boom` on Node, `/quote/0` on Python | The failed requests in red, with the exception attached. |
| 23 to 30 s | Three more orders | End on healthy traffic. |

Stop the recorder when the script prints `Done`.

## Tips

- Do not hover over the pointer-sensitive timeline while recording; it highlights
  rows and distracts.
- The Python service's dashboard shows `log.record` events for its log lines. The
  Node one shows `console.log`.
- To make the request list easier to read, widen the left pane before recording.
- If something goes wrong mid-take, stop, clear both dashboards and run the traffic
  script again. It is safe to repeat, and caches expire in 10 to 30 seconds, so the
  second run behaves like the first after a short wait.
- `DEMO_SPEED=2` plays the script at half speed, if the cuts feel rushed.

## Turning it into a GIF

Any screen recorder works. To convert a recording with `ffmpeg` and `gifski`:

```bash
ffmpeg -i demo.mov -vf "fps=15,scale=1280:-1" frames/%04d.png
gifski --fps 15 --width 1280 -o demo.gif frames/*.png
```

Keep it under 10 MB so it loads on a README.
