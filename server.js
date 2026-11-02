// LostCoin Hunter — read-only discovery MVP.
// It observes addresses appearing in recent public transactions. It never signs,
// requests seed phrases, accesses private keys, or moves funds.
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const INTERVAL = Math.max(60, Number(process.env.SCAN_INTERVAL_SECONDS || 120));
const BLOCKS_PER_SCAN = Math.min(5, Math.max(1, Number(process.env.MAX_BLOCKS_PER_SCAN || 2)));
const ADDRESS_CAP = Math.min(300, Math.max(10, Number(process.env.MAX_ADDRESSES_PER_SCAN || 80)));
const DATA_FILE = path.join(__dirname, "data.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const CHAINS = [
  { id: "ethereum", label: "Ethereum", rpc: process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com", family: "evm" },
  { id: "bsc", label: "BNB Chain", rpc: process.env.BSC_RPC_URL || "https://bsc-rpc.publicnode.com", family: "evm" },
  { id: "polygon", label: "Polygon", rpc: process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com", family: "evm" },
  { id: "solana", label: "Solana", rpc: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", family: "solana" },
  { id: "bitcoin", label: "Bitcoin", api: (process.env.BITCOIN_API_BASE || "https://mempool.space/api").replace(/\/$/, ""), family: "bitcoin" }
];

let state = { addresses: {}, chainState: {}, scans: [], status: "Starting", lastScan: null };
let scanRunning = false;

async function loadState() {
  try {
    const parsed = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    if (parsed && typeof parsed === "object") state = { ...state, ...parsed };
  } catch (e) {
    if (e.code !== "ENOENT") console.error("Could not read data.json:", e.message);
  }
}
async function saveState() {
  const temp = DATA_FILE + ".tmp";
  await fs.writeFile(temp, JSON.stringify(state, null, 2));
  await fs.rename(temp, DATA_FILE);
}
async function fetchJson(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, headers: { "content-type": "application/json", ...(options.headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}
async function rpc(url, method, params = []) {
  const result = await fetchJson(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (result.error) throw new Error(result.error.message || "RPC error");
  return result.result;
}
function upsert(chain, address, balance = null, unit = "", lastSeen = Date.now()) {
  if (!address || typeof address !== "string" || address.length > 128) return;
  const key = `${chain}:${address.toLowerCase()}`;
  const old = state.addresses[key] || { chain, address, firstSeen: lastSeen, sightings: 0 };
  state.addresses[key] = {
    ...old, chain, address, balance: balance ?? old.balance ?? null,
    unit: unit || old.unit || "", lastSeen: Math.max(old.lastSeen || 0, lastSeen),
    sightings: (old.sightings || 0) + 1
  };
}
async function scanEvm(chain) {
  const latestHex = await rpc(chain.rpc, "eth_blockNumber");
  const latest = Number.parseInt(latestHex, 16);
  if (!Number.isFinite(latest)) throw new Error("Invalid block height");
  const prior = Number(state.chainState[chain.id]?.height ?? latest - 1);
  const start = Math.max(prior + 1, latest - BLOCKS_PER_SCAN + 1);
  const end = Math.min(latest, start + BLOCKS_PER_SCAN - 1);
  let found = 0;
  for (let height = start; height <= end && found < ADDRESS_CAP; height++) {
    const block = await rpc(chain.rpc, "eth_getBlockByNumber", ["0x" + height.toString(16), true]);
    if (!block?.transactions) continue;
    for (const tx of block.transactions) {
      const stamp = Number.parseInt(block.timestamp || "0x0", 16) * 1000 || Date.now();
      if (tx.from) { upsert(chain.id, tx.from, null, "ETH/BSC/MATIC native", stamp); found++; }
      if (tx.to) { upsert(chain.id, tx.to, null, "ETH/BSC/MATIC native", stamp); found++; }
      if (found >= ADDRESS_CAP) break;
    }
  }
  state.chainState[chain.id] = { height: end, latest, checkedAt: Date.now() };
  // Balance is public account state, not proof of ownership or recoverability.
  const candidates = Object.values(state.addresses).filter(x => x.chain === chain.id).slice(-Math.min(30, ADDRESS_CAP));
  for (const item of candidates) {
    try {
      const hex = await rpc(chain.rpc, "eth_getBalance", [item.address, "latest"]);
      item.balance = (BigInt(hex) / 10n ** 12n).toString(); // value in 10^-6 native coin units
      item.unit = chain.id === "ethereum" ? "ETH (micro-units)" : chain.id === "bsc" ? "BNB (micro-units)" : "MATIC (micro-units)";
    } catch {}
  }
}
async function scanBitcoin(chain) {
  const tip = await fetchJson(`${chain.api}/blocks`);
  if (!Array.isArray(tip) || !tip.length) throw new Error("Bitcoin API returned no blocks");
  const latest = Number(tip[0].height);
  const prior = Number(state.chainState[chain.id]?.height ?? latest - 1);
  const start = Math.max(prior + 1, latest - BLOCKS_PER_SCAN + 1);
  const end = Math.min(latest, start + BLOCKS_PER_SCAN - 1);
  let found = 0;
  for (let h = start; h <= end && found < ADDRESS_CAP; h++) {
    const hash = await fetchJson(`${chain.api}/block-height/${h}`).then(x => x);
    const txs = await fetchJson(`${chain.api}/block/${hash}/txs`);
    for (const tx of txs) {
      const stamp = (tx.status?.block_time || Math.floor(Date.now()/1000)) * 1000;
      for (const out of (tx.vout || [])) {
        const addr = out.scriptpubkey_address;
        if (addr) { upsert(chain.id, addr, null, "BTC (sats)", stamp); found++; }
      }
      for (const input of (tx.vin || [])) {
        const addr = input.prevout?.scriptpubkey_address;
        if (addr) { upsert(chain.id, addr, null, "BTC (sats)", stamp); found++; }
      }
      if (found >= ADDRESS_CAP) break;
    }
  }
  state.chainState[chain.id] = { height: end, latest, checkedAt: Date.now() };
  const candidates = Object.values(state.addresses).filter(x => x.chain === chain.id).slice(-20);
  for (const item of candidates) {
    try {
      const a = await fetchJson(`${chain.api}/address/${encodeURIComponent(item.address)}`);
      const funded = a.chain_stats?.funded_txo_sum || 0;
      const spent = a.chain_stats?.spent_txo_sum || 0;
      const memFunded = a.mempool_stats?.funded_txo_sum || 0;
      const memSpent = a.mempool_stats?.spent_txo_sum || 0;
      item.balance = funded - spent + memFunded - memSpent;
      item.unit = "sats";
    } catch {}
  }
}
async function scanSolana(chain) {
  const latest = await rpc(chain.rpc, "getSlot", [{ commitment: "confirmed" }]);
  const prior = Number(state.chainState[chain.id]?.slot ?? latest - 1);
  const start = Math.max(prior + 1, latest - BLOCKS_PER_SCAN + 1);
  const end = Math.min(latest, start + BLOCKS_PER_SCAN - 1);
  let found = 0;
  for (let slot = start; slot <= end && found < ADDRESS_CAP; slot++) {
    let block;
    try {
      block = await rpc(chain.rpc, "getBlock", [slot, { encoding: "jsonParsed", transactionDetails: "full", rewards: false, maxSupportedTransactionVersion: 0 }]);
    } catch { continue; }
    for (const tx of (block?.transactions || [])) {
      const keys = tx.transaction?.message?.accountKeys || [];
      for (const key of keys) {
        const addr = typeof key === "string" ? key : key.pubkey;
        if (addr) { upsert(chain.id, addr, null, "SOL (lamports)", (block.blockTime || Math.floor(Date.now()/1000))*1000); found++; }
        if (found >= ADDRESS_CAP) break;
      }
      if (found >= ADDRESS_CAP) break;
    }
  }
  state.chainState[chain.id] = { slot: end, latest, checkedAt: Date.now() };
  const candidates = Object.values(state.addresses).filter(x => x.chain === chain.id).slice(-20);
  for (const item of candidates) {
    try {
      const b = await rpc(chain.rpc, "getBalance", [item.address, { commitment: "confirmed" }]);
      item.balance = b?.value ?? null; item.unit = "lamports";
    } catch {}
  }
}
async function scanAll() {
  if (scanRunning) return;
  scanRunning = true;
  state.status = "Scanning public chain data";
  const started = Date.now();
  const results = [];
  for (const chain of CHAINS) {
    try {
      if (chain.family === "evm") await scanEvm(chain);
      else if (chain.family === "bitcoin") await scanBitcoin(chain);
      else await scanSolana(chain);
      results.push({ chain: chain.id, ok: true });
    } catch (e) {
      results.push({ chain: chain.id, ok: false, error: e.message });
    }
  }
  state.lastScan = Date.now();
  state.status = "Monitoring public blockchain data";
  state.scans.unshift({ at: state.lastScan, durationMs: Date.now() - started, results });
  state.scans = state.scans.slice(0, 30);
  try { await saveState(); } catch (e) { console.error("Save failed:", e.message); }
  scanRunning = false;
}
function send(res, status, data, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/api/status") {
    const rows = Object.values(state.addresses);
    const dormant = rows.filter(x => Date.now() - (x.lastSeen || Date.now()) > 180 * 86400000);
    return send(res, 200, { status: state.status, lastScan: state.lastScan, scanRunning, totalObserved: rows.length, dormantObserved: dormant.length, chains: CHAINS.map(c => ({ id: c.id, label: c.label, state: state.chainState[c.id] || null })), recentScans: state.scans.slice(0, 8) });
  }
  if (req.method === "GET" && url.pathname === "/api/addresses") {
    const chain = url.searchParams.get("chain");
    const sort = url.searchParams.get("sort") || "lastSeen";
    let rows = Object.values(state.addresses).filter(x => !chain || x.chain === chain);
    rows.sort((a,b) => sort === "sightings" ? (b.sightings||0)-(a.sightings||0) : (b.lastSeen||0)-(a.lastSeen||0));
    return send(res, 200, rows.slice(0, 500));
  }
  if (req.method === "POST" && url.pathname === "/api/scan") {
    scanAll().catch(e => console.error(e));
    return send(res, 202, { accepted: true, message: "Scan started" });
  }
  if (req.method === "GET") {
    const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, "Forbidden", "text/plain");
    try {
      const body = await fs.readFile(file);
      const ext = path.extname(file);
      const type = ext === ".html" ? "text/html; charset=utf-8" : ext === ".css" ? "text/css" : "application/javascript";
      return send(res, 200, body, type);
    } catch { return send(res, 404, "Not found", "text/plain"); }
  }
  return send(res, 404, { error: "Not found" });
});
(async () => {
  await loadState();
  server.listen(PORT, () => console.log(`LostCoin Hunter running at http://localhost:${PORT}`));
  scanAll().catch(console.error);
  setInterval(() => scanAll().catch(console.error), INTERVAL * 1000);
})();
