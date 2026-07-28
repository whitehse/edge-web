/**
 * Graph types and source kinds for the technician picker.
 */

export const GRAPH_TYPES = [
  {
    id: "host.cpu",
    group: "Host",
    label: "CPU by core",
    desc: "Per-core busy % plus aggregate and iowait",
    sourceKinds: ["cpe"],
    live: true
  },
  {
    id: "host.mem",
    group: "Host",
    label: "Memory",
    desc: "RAM used % of total",
    sourceKinds: ["cpe"],
    live: true
  },
  {
    id: "host.net",
    group: "Host",
    label: "Network rate",
    desc: "Non-loopback rx / tx bits per second",
    sourceKinds: ["cpe"],
    live: true
  },
  {
    id: "host.load",
    group: "Host",
    label: "Load average",
    desc: "load1 / 5 / 15 vs core count",
    sourceKinds: ["cpe"],
    live: true
  },
  {
    id: "wifi.radio",
    group: "Wi‑Fi",
    label: "Radio health",
    desc: "Stations, channel util, noise",
    sourceKinds: ["cpe", "radio", "band"],
    live: true
  },
  {
    id: "wifi.client",
    group: "Wi‑Fi",
    label: "Client coverage",
    desc: "RSSI, link rate, throughput for one station",
    sourceKinds: ["wifi_client"],
    live: true
  },
  {
    id: "wifi.band",
    group: "Wi‑Fi",
    label: "Band activity",
    desc: "Stations filtered to 2.4 / 5 / 6 GHz",
    sourceKinds: ["band"],
    live: true
  },
  {
    id: "flow.overlay",
    group: "Flows",
    label: "Flow overlay",
    desc: "Top streams stacked in time",
    sourceKinds: ["cpe"],
    live: true
  },
  {
    id: "flow.stream",
    group: "Flows",
    label: "Single stream",
    desc: "Down / up rate for one flow_id",
    sourceKinds: ["flow"],
    live: true
  },
  {
    id: "flow.defects",
    group: "Flows",
    label: "Defect timeline",
    desc: "Retrans / loss / tiny window markers",
    sourceKinds: ["cpe"],
    live: true
  }
];

export const SOURCE_KINDS = [
  {
    id: "cpe",
    label: "CPE",
    desc: "Single customer router (router_id)",
    live: true,
    fields: [{ key: "router_id", label: "router_id", placeholder: "cpe or serial" }]
  },
  {
    id: "wifi_client",
    label: "Wi‑Fi client",
    desc: "Station MAC on a CPE",
    live: true,
    fields: [
      { key: "router_id", label: "router_id", placeholder: "cpe" },
      { key: "client_mac", label: "client MAC", placeholder: "aa:bb:…" }
    ]
  },
  {
    id: "flow",
    label: "Flow stream",
    desc: "One flow_id on a CPE",
    live: true,
    fields: [
      { key: "router_id", label: "router_id", placeholder: "cpe" },
      { key: "flow_id", label: "flow_id", placeholder: "hex id" }
    ]
  },
  {
    id: "band",
    label: "RF band",
    desc: "2.4 / 5 / 6 GHz on a CPE (client-side filter)",
    live: true,
    fields: [
      { key: "router_id", label: "router_id", placeholder: "cpe" },
      {
        key: "band",
        label: "band",
        placeholder: "2.4 | 5 | 6",
        options: ["2.4", "5", "6"]
      }
    ]
  },
  {
    id: "radio",
    label: "Radio / ifname",
    desc: "wifi0 / wifi1 when present on samples",
    live: true,
    fields: [
      { key: "router_id", label: "router_id", placeholder: "cpe" },
      { key: "ifname", label: "ifname", placeholder: "wifi0" }
    ]
  },
  {
    id: "cpe_group.pon",
    label: "PON group",
    desc: "All CPEs on a PON — needs inventory join",
    live: false,
    stub: "Coming soon: join l3_hosts → ont_status.pon_id"
  },
  {
    id: "cpe_group.tap",
    label: "Fiber tap",
    desc: "CPEs on a fiber tap — needs map inventory",
    live: false,
    stub: "Coming soon: fiber design inventory link"
  },
  {
    id: "aggregate.border",
    label: "Border router",
    desc: "Aggregate flows through a border",
    live: false,
    stub: "Coming soon: path_id / IPFIX rollups"
  },
  {
    id: "aggregate.core",
    label: "Core router / path",
    desc: "Core path blast radius",
    live: false,
    stub: "Coming soon: RIB/BMP path_id population"
  }
];

export function typeById(id) {
  for (let i = 0; i < GRAPH_TYPES.length; i++) {
    if (GRAPH_TYPES[i].id === id) return GRAPH_TYPES[i];
  }
  return null;
}

export function sourceById(id) {
  for (let i = 0; i < SOURCE_KINDS.length; i++) {
    if (SOURCE_KINDS[i].id === id) return SOURCE_KINDS[i];
  }
  return null;
}

export function titleForPanel(panel) {
  const t = typeById(panel.typeId);
  const base = t ? t.label : panel.typeId;
  const s = panel.source || {};
  if (s.client_mac) return base + " · " + s.client_mac;
  if (s.flow_id) return base + " · " + String(s.flow_id).slice(0, 10);
  if (s.band) return base + " · " + s.band + " GHz";
  if (s.ifname) return base + " · " + s.ifname;
  if (s.router_id) return base + " · " + s.router_id;
  return base;
}
