# Open Downlink Custody

Signed custody receipts and cross-station corroboration for **real satellite downlinks**,
built on the public [SatNOGS](https://network.satnogs.org/) ground-station network.

SatNOGS volunteers run hundreds of ground stations and publish every frame they decode.
What the archive does not record is proof: that a frame was not changed after upload,
which independently owned stations received exactly the same bytes, and what each
station missed. Open Downlink Custody adds that layer using only public data, with zero
dependencies (Node 20+).

> Open Downlink Custody is not affiliated with or endorsed by the Libre Space Foundation.

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
never data or personal information. Anchoring is a separate, manual step.

**Can I use this commercially?**
The software, yes, under Apache-2.0. SatNOGS data remains CC BY-SA: credit its
contributors and share derived data under the same license.

**Who owns this?**
Embryo Space Inc. (DBA BSVKey). See [OWNERSHIP.md](OWNERSHIP.md) and [NOTICE](NOTICE).

**How do I request a change?**
Open an issue or a pull request. See [CONTRIBUTING.md](CONTRIBUTING.md). Requests from the
Libre Space Foundation and station operators get priority.

## License

Software: Apache License 2.0, provided "AS IS", without warranties or conditions of any
kind (see [LICENSE](LICENSE), section 7). Copyright 2026 Embryo Space Inc. (DBA BSVKey).

Data: SatNOGS Network contributors, CC BY-SA. Not part of this software.
