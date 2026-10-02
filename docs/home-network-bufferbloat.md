# Home Network: Bufferbloat, SQM/cake and the Flint router

Written 2026-08-29 after diagnosing sudden high ping while playing Call of Duty.
Everything below was measured on the live network, not assumed.

---

## 1. The symptom

Ping while gaming jumped from ~12 ms to **65 ms average, spiking to 96 ms**, with heavy
jitter. It started "all of a sudden" with no config change.

## 2. Diagnosis (what was actually done)

The router is a **GL.iNet Flint** running OpenWrt, reachable as `ssh flint`.
It uses `ash`, not bash, and lacks `hostname` and `file`.

Steps, in order:

1. **Measure the symptom locally** — `ping 1.1.1.1` from the PC confirmed 65 ms avg / 96 ms max.
2. **Find the direction of the problem** — sample WAN byte counters twice, 5 s apart:
   ```sh
   ssh flint "grep -E 'eth1|br-lan' /proc/net/dev; sleep 5; echo ---; grep -E 'eth1|br-lan' /proc/net/dev"
   ```
   Result: ~42 Mbit/s **upload**, download nearly idle. So it was an upload flood,
   on a 50 Mbit/s uplink — ~85 % saturation.
3. **Find the interface it enters on** — same technique across `lan1..lan5`, `ra0` (2.4 GHz),
   `rax0` (5 GHz). The traffic arrived on `ra0`, so a 2.4 GHz wireless client.
4. **Find the device** — per-client byte counters are **not** available via
   `iwinfo ra0 assoclist` on this MediaTek driver (it reports `0 Pkts`).
   Use conntrack instead, which has accounting enabled — look for flows over 50 MB in
   `/proc/net/nf_conntrack` (see the runbook for the one-liner).
   One flow dominated: `192.168.0.6 -> 188.114.97.3:443`, 63 MB up vs 1 MB down.
   Sampling it twice showed ~38 Mbit/s sustained.
5. **Identify the host** — `ip neigh show | grep '192.168.0.6 '` gave MAC `e2:22:c9:bd:0c:09`,
   a randomised (private) MAC, absent from `/tmp/dhcp.leases`.
   Confirmed by Felix: **his phone**, running a photo/video cloud backup
   (destination is Cloudflare-fronted, which is why the IP is a Cloudflare edge).

### Root cause

**Bufferbloat.** The uplink is a fixed-width pipe. When the backup filled it, packets
queued in a large dumb buffer. Game packets are tiny and latency-critical but had to wait
behind bulk backup packets in the same FIFO queue. Queue delay = the extra 50 ms.

The phone was not doing anything wrong — the network simply had no queue management.

---

## 3. The fix: SQM with cake

`sqm-scripts` + `kmod-sched-cake` were **already installed** on the GL.iNet firmware but
disabled, and pointed at the wrong interface (`br-lan` instead of the WAN).

```sh
uci set sqm.eth1.interface='eth1'      # WAN, not br-lan
uci set sqm.eth1.enabled='1'
uci set sqm.eth1.upload='45000'        # kbit
uci set sqm.eth1.download='750000'     # kbit
uci set sqm.eth1.linklayer='ethernet'
uci set sqm.eth1.overhead='18'         # DOCSIS/Ethernet framing
uci commit sqm
/etc/init.d/sqm restart
```

> Note: `/etc/init.d/sqm restart` prints `sh: out of range` on this firmware even when it
> succeeds. **Ignore it and verify with `tc` instead** (see the runbook below).

### Why shaping *below* line rate is the whole trick

Cake deliberately forwards slightly slower than the line can carry. This moves the
bottleneck — and therefore the queue — **from the ISP/modem into the router**, where cake
controls it. If cake is configured *above* the real line rate, the bottleneck stays
upstream, cake never engages, and it silently does nothing.

**This is why the configured rate must be below what the line truly delivers.**

### How cake decides what is "important"

Mostly it does not — there is no list of important applications. Three mechanisms combine:

1. **Per-flow queueing.** Every packet is hashed by 5-tuple (src IP, dst IP, src port,
   dst port, protocol) into one of ~1024 sub-queues, served round-robin by bytes (DRR).
   A game flow with 1 packet waiting does not queue behind a backup flow with 5 000 —
   they are in different queues. The bulk flow's backlog becomes its own problem.
2. **Sparse-flow boost** — the one real heuristic. A packet arriving for a flow whose queue
   was *empty* jumps to the front. Game traffic (small UDP every ~16 ms), DNS, VoIP and SSH
   naturally qualify; a continuous backup stream never does. Traffic self-classifies by
   **behaviour**, so no port lists or "gaming mode" are needed.
3. **CoDel inside each queue.** Packets are timestamped on arrival; if they consistently sit
   longer than ~5 ms, CoDel drops one occasionally. That is TCP's signal to slow down, so
   bulk senders throttle themselves instead of stuffing the buffer.

`triple-isolate` (set here) adds **per-host fairness before per-flow fairness**: a device
opening 20 parallel connections shares one host's fair share rather than getting 20 votes.
That is exactly the cloud-backup pattern.

DSCP priority "tins" are deliberately **not** used (`besteffort`): applications lie about
their own priority, ISPs mangle the marks, and Windows mostly does not set them. The
behavioural heuristic is more trustworthy than what packets claim about themselves.

---

## 4. The important discovery: download shaping is CPU-bound

The plan is 1000/50. Initial measurement suggested only ~800 Mbit/s down, which looked like
old-building wiring. **That conclusion was wrong** — the measurement was taken with cake
already active, so it measured the shaper, not the line.

Back-to-back test, identical conditions (6 parallel streams, OVH + Hetzner + wtnet):

| Config | Download | Router softirq CPU |
|---|---|---|
| cake ingress @ 750 Mbit | 677 Mbit/s | 41 % |
| **no ingress shaping** | **927 Mbit/s** | 14 % |

**The line genuinely delivers ~925 Mbit/s.** Software shaping bypasses the router's
MediaTek hardware NAT offload, so every packet is handled by the CPU — cheap at 45 Mbit
upload, expensive near gigabit. Cake tops out around 700 Mbit on this hardware.

### Tuning comparison (measured back-to-back)

| Ingress setting | Actual throughput | Ping under full download load |
|---|---|---|
| off | 927 Mbit/s | 24 ms avg / 31 ms max |
| 600 Mbit | 558 Mbit/s | 13 ms avg / 19 ms max |
| **750 Mbit (chosen)** | **695 Mbit/s** | **12 ms avg / 15 ms max** |

750 beat 600 on *both* axes, so 600 was discarded. Note that at 750 the CPU, not the token
bucket, is the binding constraint — but latency stayed excellent, so it is a fine operating
point.

---

## 5. Final configuration

```
sqm.eth1.interface = eth1
sqm.eth1.enabled   = 1
sqm.eth1.upload    = 45000     # 45 Mbit  (of 50 nominal)
sqm.eth1.download  = 750000    # 750 Mbit (of ~925 real)
sqm.eth1.linklayer = ethernet
sqm.eth1.overhead  = 18
sqm.eth1.qdisc     = cake / piece_of_cake.qos
```

Committed via `uci commit sqm`, so it survives reboots.

### Results

| Scenario | Before | After |
|---|---|---|
| Idle ping | ~12 ms | ~12 ms |
| Upload saturated (the original failure) | 65 ms avg / 96 ms max | 12 ms avg |
| Download saturated | (untested) | 12 ms avg / 15 ms max |
| Max download | 927 Mbit/s | 695 Mbit/s |

**The trade:** ~230 Mbit/s of peak download given up in exchange for flat latency under
load. Deliberate choice — smoothness while gaming was worth more than peak throughput.

---

## 6. Landmines

### GL.iNet per-client QoS wipes cake

The GL UI's **per-client QoS / speed limit** feature (`gl_eqos`, uci config `qos`) includes
the WAN device and runs:

```sh
tc qdisc del dev $dev root      # <- deletes cake on eth1
tc qdisc add dev $dev root handle 1: htb
```

Enabling it **silently destroys the bufferbloat fix**, replacing cake with HTB + plain
pfifo. No error is shown. If it is ever enabled, re-apply SQM afterwards.

### DPI QoS is safe but redundant

The **DPI Engine → QoS** beta feature (`gl_dpi_qos`) is a *different* thing and only touches
`br-lan` / `br-guest`, so it does **not** delete cake on `eth1`. However it is cruder:
netifyd tags flows into 3 categories via nftables conntrack labels, then applies HTB with
3 strict-priority bands and no AQM inside them. It also shapes at the LAN bridge — if its
limits are set below cake's, the bottleneck moves to `br-lan` where there is no queue
management, and bufferbloat returns through the side door. **Not recommended alongside cake.**

---

## 7. DPI engine notes (GL.iNet beta feature)

`netifyd` (DPI, ~100 MB RAM) is **already running**, classifying every flow by application.
Three features sit on top, all currently **off**:

| Feature | uci config | Verdict |
|---|---|---|
| Data Statistics | `gl_dpi_flow_statistics` | **Worth enabling.** Writes per-app/per-client traffic to a SQLite DB at `/etc/netifyd/traffic_data.db` (working copy in `/tmp`). Directly queryable for a dashboard. |
| QoS | `gl_dpi_qos` | Skip — see landmines above. |
| Content Filter | `gl_dpi_content_protection` | Independent (gambling/adult/malware categories). Personal choice. |

### Dashboard idea (not yet built)

Prometheus + Grafana on `felixnuc`, scraping:

- `prometheus-node-exporter-lua` on the router — per-interface throughput, WiFi signal.
- `tc -s -j qdisc show dev eth1` — cake exposes its **entire internal state as JSON**:
  queue delay, drops, marks, backlog, sparse vs bulk flow counts. Lets you *see* cake
  disciplining a backup in real time.
- The DPI `traffic_data.db` SQLite file — per-device/per-app history.

Pre-built alternatives: GL.iNet's own UI (zero effort, limited history), `nlbwmon` + LuCI
(per-device accounting, no cake internals), or `ntopng` on the NUC (heavyweight, full
per-flow visibility).

---

## 8. Runbook

### Verify the fix is live

```sh
ssh flint "tc qdisc show dev eth1 | head -1; tc qdisc show dev ifb4eth1 | head -1"
```

Expect `cake ... bandwidth 45Mbit` (egress/upload) and `cake ... bandwidth 750Mbit`
(ingress/download). If `fq_codel` appears instead, SQM is off or was wiped — see landmines.

### See cake working (drops/backlog should move under load)

```sh
ssh flint "tc -s qdisc show dev eth1 | head -4"
```

### Find who is hogging the line, right now

```sh
# 1. direction + rate
ssh flint "grep eth1 /proc/net/dev; sleep 5; echo ---; grep eth1 /proc/net/dev"

# 2. heavy flows (>50 MB) — note the escaping, this runs through ssh
ssh flint 'awk "{for(i=1;i<=NF;i++){if(\$i ~ /^bytes=/){split(\$i,b,\"=\"); if(b[2]>50000000){print \$0; break}}}}" /proc/net/nf_conntrack'

# 3. map IP -> MAC -> name
ssh flint "ip neigh show; cat /tmp/dhcp.leases"
```

Devices with randomised MACs (phones) will not appear in `dhcp.leases` by name — match the
MAC from `ip neigh` instead.

### Re-measure the real line rate

Must be done with **SQM stopped**, or you measure the shaper:

```sh
ssh flint "/etc/init.d/sqm stop"
# ...run the speed test below...
ssh flint "/etc/init.d/sqm start"
```

### Speed-test hosts that actually work with curl

- `https://proof.ovh.net/files/1Gb.dat`
- `https://fsn1-speed.hetzner.com/1GB.bin`
- `https://speedtest.wtnet.de/files/1000mb.bin`
- `speed.cloudflare.com` returns **403 to curl** (needs a browser User-Agent, then
  rate-limits parallel streams). Avoid.
- Upload sink: `POST https://speedtest.init7.net/backend/empty.php` (caps chunks at ~1 MB).

A single TCP stream will not saturate a gigabit line — use 4–6 in parallel across
**different hosts**, then sum the per-stream `%{speed_download}` values.

### When to retune

- If a speed test shows noticeably less than 750 Mbit down, the line has degraded and the
  shaper must follow it **down** (shaping above the real rate = no protection at all).
- Worth re-measuring off-peak: these tests ran ~22:30, prime time on shared DOCSIS.
