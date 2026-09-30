# Open Downlink Custody run 2026-09-29T04-57-17-361Z

Window: 2026-09-29T01:57:17.361Z to 2026-09-29T04:57:17.361Z (3 h)
Data: SatNOGS Network contributors (https://network.satnogs.org), licensed CC BY-SA.
The records in this folder are derived from that data and are shared under CC BY-SA 4.0.
Open Downlink Custody is not affiliated with or endorsed by the Libre Space Foundation.

| Passes | Stations | Independent owners | Unique frames | Corroborated (2+ owners) |
|---|---|---|---|---|
| 3 | 13 | 12 | 212 | 15 |

| NORAD | Pass start (UTC) | Stations | Owners | Unique frames | Corroborated | Missed (gap records) |
|---|---|---|---|---|---|---|
| 98330 | 2026-09-29 04:08:12 | 6 | 6 | 51 | 2 | 160 |
| 69015 | 2026-09-29 04:38:03 | 4 | 4 | 137 | 9 | 211 |
| 98492 | 2026-09-29 03:43:58 | 4 | 3 | 24 | 4 | 46 |

Batch root: `76d34ef5fb0b2d410dff97d486bf7d0e12c8bccd63e832916fe11ed3cfb87135`
Batch id: `0x52df1ef26424825239ca0d52da0380a95903fe1e665b0c4738060a7e90d28eb4`
Self-check: PASS

What this attests: each station receipt records every frame the public archive served
for that observation, content-addressed and signed by the custody agent. Stations do
not sign their own uploads today, so trust comes from corroboration: a frame received
byte-for-byte by stations with different owners. The batch root is the single value to
anchor on chain; anchoring is a separate, manual step.

Reading the numbers: satellites often send several frames per second and each station
decodes only some of them, so a low corroborated count usually means the stations caught
different frames, not that they disagree. "Missed" counts frames another station archived
inside a station's own window that it did not archive: a reception gap record, not a
custody failure.

Re-verify independently: `node bin/verify.mjs --run out/2026-09-29T04-57-17-361Z --pub <custody public key>`
(add `--refetch` to re-download every frame from SatNOGS and compare).
