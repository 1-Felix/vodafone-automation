// /proc/gl-kmwan/status as captured on the Flint on 2026-10-02 (GL 4.9.1): a
// header row, then one block per member, each ending in a blank line. The
// numeric columns run together, so only a block's first field and its flag
// lines mean anything.
export const KMWAN_STATUS_HEADER =
  "Interface       Netdev           Ifindex   State          TrackMode       TX packets      TX stamp        RX packets   RX stamp        \n";

export const KMWAN_WAN_BLOCK = [
  "wan             eth1             3         ACTIVE         force           1701            29193095640381672732         2919310458935646",
  "Track method\tip Info",
  "ping        \t1.1.1.1",
  "ping        \t8.8.8.8",
  "ping        \t208.67.222.222",
  "ping        \t208.67.220.220",
  "online:true     state_sync:1",
  "probe_enable:true",
  "force_dead:false",
  "",
  "",
].join("\n");

export const KMWAN_LTE_BLOCK = [
  "secondwan       lan5             7         IDEL           passive         0               0               0            0               ",
  "Track method\tip Info",
  "ping        \t1.1.1.1",
  "ping        \t8.8.8.8",
  "ping        \t208.67.222.222",
  "ping        \t208.67.220.220",
  "online:true     state_sync:1",
  "probe_enable:true",
  "force_dead:false",
  "",
  "",
].join("\n");
