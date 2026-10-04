# Open Downlink Custody

Signed custody receipts and cross-station corroboration for **real satellite downlinks**,
built on the public [SatNOGS](https://network.satnogs.org/) ground-station network.

SatNOGS volunteers run hundreds of ground stations and publish every frame they decode.
What the archive does not record is proof: that a frame was not changed after upload,
which independently owned stations received exactly the same bytes, and what each
station missed. Open Downlink Custody adds that layer using only public data, with zero
dependencies (Node 20+).

> Open Downlink Custody is not affiliated with or endorsed by the Libre Space Foundation.

**Discussion:** [Libre Space community forum thread](https://community.libre.space/t/open-downlink-custody-custody-receipts-over-satnogs-data-feedback-and-requests-welcome/15384). Feedback and requests welcome.

## What it produces

| Record | Scope | Contents |
|---|---|---|
| Station receipt | one observation | every archived frame, content-addressed (Merkle leaf per frame, root over all), source URL, station ID, name and operator handle, signed |
| Pass manifest | one satellite pass | every station that heard it, unique frames, frames corroborated by 2+ independent owners, gap records for frames a station missed inside its own window, signed |
| Custody batch | one run | Merkle root over pass manifests with an inclusion proof per manifest: the single value to anchor on a public ledger |

Every record carries the SatNOGS credit and license. Each run folder also gets a
`DATA-LICENSE.md`. Records never contain station coordinates, hostnames or frame contents.

## Use

```bash
node bin/run.mjs                              # best multi-station passes, last 6 h
node bin/run.mjs --norad 59112 --hours 12     # one satellite
node bin/verify.mjs --run out/<runId> --pub <custody public key> --refetch
node bin/verify.mjs --frame f.bin --receipt out/<runId>/receipts/<obsId>.json --pub <key>
npm test                                      # offline suite
```

`--refetch` re-downloads every frame from SatNOGS and checks it against the receipts, so
anyone can confirm a run without trusting the machine that produced it.

## Compare station clocks

Frames that several stations decode byte for byte are the same transmission, so their receive times should agree. `bin/clocks.mjs` uses that to estimate each station's clock offset against the others, with no satellite clock involved:

```bash
node bin/clocks.mjs --run runs/2026-09-29T04-57-17-361Z
```

- It uses only transmissions heard by 3 or more stations, and each station at most once.
- The same bytes repeated minutes later (common for beacons) count as separate transmissions.
- Offsets are solved jointly, so one wrong clock is pinned on that station instead of shifting its neighbours.
- SatNOGS frame times are whole seconds, so offsets of 1 s or less are within resolution. A flag based on a handful of frames is a hint to check, not a verdict.

On a 12-hour run of 4 October 2026 (128 receipts, 281 transmissions heard by 3+ stations, 42 stations), almost every station sat at 0 s. Two stations showed offsets of about 6 to 7 seconds, each based on fewer than 10 frames.

## Anchored run: check it yourself

[`runs/2026-09-29T04-57-17-361Z/`](runs/2026-09-29T04-57-17-361Z/) is a real run (3 passes,
13 stations, 12 independent owners, 242 frames) whose batch root is anchored on BSV
mainnet in tx [`3528965b42b56b4ca28b5b042b45b13f4a8bee16bd77b2e134531a8224cafe16`](https://whatsonchain.com/tx/3528965b42b56b4ca28b5b042b45b13f4a8bee16bd77b2e134531a8224cafe16).

```bash
node bin/verify.mjs --run runs/2026-09-29T04-57-17-361Z --refetch --anchor 3528965b42b56b4ca28b5b042b45b13f4a8bee16bd77b2e134531a8224cafe16 \
  --pub MCowBQYDK2VwAyEA+lWXmGkpas54MnWmHpwKr7Ee1ekI5PndX4j7+zndIS8=
```

This checks every signature and inclusion proof, re-downloads all 242 frames from SatNOGS
and compares them to the receipts, and confirms the batch root is in the anchor
transaction's OP_RETURN. Any changed frame, record or root fails.

## Station operators: sign at the source

`bin/station-hook.mjs` runs after each observation, before upload, and signs the frames
your station decoded with your station's own key. It is receive-only and local: it reads
files satnogs-client already wrote, writes one JSON receipt, and never blocks the client.

```bash
# satnogs-client setting (check the variable name against your client version)
SATNOGS_POST_OBSERVATION_SCRIPT="node /path/to/open-downlink-custody/bin/station-hook.mjs --id {{ID}}"
```

## FAQ

**What problem does this solve?**
Satellite data passes through many hands: the spacecraft, one or more ground stations,
an archive, then whoever uses it. Today there is no simple, independent way to prove a
given frame is exactly what was received, who else received it, and what was lost along
the way. This tool records all three in a form anyone can check.

**Do I need an account, a license or a radio?**
No. The network-side witness only reads the public SatNOGS archive. Running the station
hook requires a SatNOGS station, which you already have if you want to use it.

**Does it ever transmit to a satellite?**
No. Everything is receive-only. It reads files and public web pages.

**What does a receipt actually prove?**
A network-side receipt proves what the public archive served for an observation at the
time it was witnessed, signed by the witness. It does not prove the station signed it,
because stations do not sign uploads today. Two things raise confidence: byte-identical
frames received by stations with different owners (corroboration), and receipts signed
by stations themselves with the station hook.

**Why do some passes show few or no corroborated frames?**
Satellites often transmit several frames per second and each station decodes only some
of them, so two stations frequently capture different frames. That is normal and is not
a disagreement between stations.

**What does "missed" mean?**
A frame another station archived during a station's own observation window that this
station did not archive. It is a reception gap record, not a failure or an accusation.

**Is any personal information recorded?**
Only what identifies a station on SatNOGS: station ID, station name and the operator's
public handle. Coordinates, hostnames and frame contents are never recorded.

**How is SatNOGS credited, and what license applies to the output?**
SatNOGS data is licensed CC BY-SA by its contributors. Every record and every run folder
credits the SatNOGS Network, and output derived from that data is shared under CC BY-SA
4.0. The software itself is Apache-2.0.

**Will this overload SatNOGS?**
It downloads each frame once and caches it locally, retries politely and identifies
itself in its User-Agent. If the Libre Space Foundation prefers a different request rate
or access pattern, we will change it: please open an issue.

**Can I verify someone else's run?**
Yes. Get their run folder and their custody public key, then run
`node bin/verify.mjs --run <folder> --pub <key> --refetch`.

**What is the on-chain anchor for?**
Optional. Publishing the batch root on a public ledger fixes, permanently and publicly,
that the records existed unchanged at that time. Only the root (a hash) is published,
never data or personal information. Anchoring is a separate, manual step:
`bin/anchor.mjs` builds and signs the transaction (it needs `@bsv/sdk` and a small funded
key) but never broadcasts it. `bin/verify.mjs --anchor <txid>` checks one.

**Can I use this commercially?**
The software, yes, under Apache-2.0. SatNOGS data remains CC BY-SA: credit its
contributors and share derived data under the same license.

**Who owns this?**
Embryo Space Inc. (DBA BSVKey). See [OWNERSHIP.md](OWNERSHIP.md) and [NOTICE](NOTICE).

**How do I request a change?**
Open an issue or a pull request (see [CONTRIBUTING.md](CONTRIBUTING.md)), or reply on the
[forum thread](https://community.libre.space/t/open-downlink-custody-custody-receipts-over-satnogs-data-feedback-and-requests-welcome/15384). Requests from the
Libre Space Foundation and station operators get priority.

## Record format

Record formats are specified in [CUSTODY-RECORDS.md](https://github.com/BSVKey/dtn-custody-demo/blob/main/spec/CUSTODY-RECORDS.md), with test vectors.

## License

Software: Apache License 2.0, provided "AS IS", without warranties or conditions of any
kind (see [LICENSE](LICENSE), section 7). Copyright 2026 Embryo Space Inc. (DBA BSVKey).

Data: SatNOGS Network contributors, CC BY-SA. Not part of this software.
