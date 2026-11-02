// GitHub Actions scanner for LostCoin Hunter. Read-only public-chain sampling.
// It records addresses visible in a small sample of recent transactions only.
const fs = require('node:fs/promises');
const path = require('node:path');
const OUT = path.join(process.cwd(), 'data.json');
const LIMIT = 120;
const RPCS = [
  {id:'ethereum', label:'Ethereum', url:'https://ethereum-rpc.publicnode.com'},
  {id:'bsc', label:'BNB Chain', url:'https://bsc-rpc.publicnode.com'},
  {id:'polygon', label:'Polygon', url:'https://polygon-bor-rpc.publicnode.com'}
];
const blank = {updatedAt:null, status:'No scan has completed yet', totalObserved:0, addresses:[], chains:[], notes:'Recent-block sample only; not a historical wallet index.'};
let data = blank;
try { data = {...blank, ...JSON.parse(await fs.readFile(OUT,'utf8'))}; } catch {}
const map = new Map((data.addresses || []).map(x => [`${x.chain}:${x.address.toLowerCase()}`, x]));
const chainResults = [];
async function json(url, options={}) {
  const r = await fetch(url,{...options,signal:AbortSignal.timeout(18000),headers:{'content-type':'application/json',...(options.headers||{})}});
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function rpc(url, method, params=[]) {
  const r = await json(url,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  if (r.error) throw new Error(r.error.message || 'RPC error');
  return r.result;
}
function record(chain,address,seenAt,unit) {
  if (!address || typeof address !== 'string' || address.length > 128) return;
  const key = `${chain}:${address.toLowerCase()}`;
  const old = map.get(key) || {chain,address,firstSeen:seenAt,sightings:0};
  map.set(key,{...old,address,lastSeen:Math.max(old.lastSeen||0,seenAt),sightings:(old.sightings||0)+1,unit:unit||old.unit||''});
}
for (const c of RPCS) {
  try {
    const latestHex = await rpc(c.url,'eth_blockNumber');
    const height = Number.parseInt(latestHex,16);
    const block = await rpc(c.url,'eth_getBlockByNumber',['0x'+height.toString(16),true]);
    let found=0;
    for (const tx of (block?.transactions||[])) {
      const stamp=(Number.parseInt(block.timestamp||'0x0',16)*1000)||Date.now();
      record(c.id,tx.from,stamp,c.id==='ethereum'?'ETH':c.id==='bsc'?'BNB':'POL');
      record(c.id,tx.to,stamp,c.id==='ethereum'?'ETH':c.id==='bsc'?'BNB':'POL');
      found += (tx.from?1:0)+(tx.to?1:0);
      if(found>=LIMIT) break;
    }
    chainResults.push({id:c.id,label:c.label,ok:true,height,addressesSampled:found});
  } catch(e) { chainResults.push({id:c.id,label:c.label,ok:false,error:String(e.message||e)}); }
}
try {
  const api='https://mempool.space/api';
  const blocks=await json(api+'/blocks');
  if(!Array.isArray(blocks)||!blocks.length) throw new Error('No recent Bitcoin blocks returned');
  const block=blocks[0];
  const txs=await json(`${api}/block/${block.id}/txs`);
  let found=0;
  for(const tx of txs) {
    const stamp=(tx.status?.block_time||Math.floor(Date.now()/1000))*1000;
    for(const out of (tx.vout||[])) if(out.scriptpubkey_address){record('bitcoin',out.scriptpubkey_address,stamp,'BTC');found++;}
    for(const input of (tx.vin||[])) if(input.prevout?.scriptpubkey_address){record('bitcoin',input.prevout.scriptpubkey_address,stamp,'BTC');found++;}
    if(found>=LIMIT) break;
  }
  chainResults.push({id:'bitcoin',label:'Bitcoin',ok:true,height:block.height,addressesSampled:found});
} catch(e) { chainResults.push({id:'bitcoin',label:'Bitcoin',ok:false,error:String(e.message||e)}); }
try {
  const url='https://api.mainnet-beta.solana.com';
  const latest=await rpc(url,'getSlot',[{commitment:'confirmed'}]);
  const block=await rpc(url,'getBlock',[latest,{encoding:'jsonParsed',transactionDetails:'full',rewards:false,maxSupportedTransactionVersion:0}]);
  let found=0;
  for(const tx of (block?.transactions||[])) {
    for(const key of (tx.transaction?.message?.accountKeys||[])) {
      const address=typeof key==='string'?key:key.pubkey;
      if(address) {record('solana',address,(block.blockTime||Math.floor(Date.now()/1000))*1000,'SOL');found++;}
      if(found>=LIMIT) break;
    }
    if(found>=LIMIT) break;
  }
  chainResults.push({id:'solana',label:'Solana',ok:true,height:latest,addressesSampled:found});
} catch(e) { chainResults.push({id:'solana',label:'Solana',ok:false,error:String(e.message||e)}); }
const addresses=[...map.values()].sort((a,b)=>(b.lastSeen||0)-(a.lastSeen||0)).slice(0,1000);
const ok=chainResults.filter(x=>x.ok).length;
data={updatedAt:new Date().toISOString(),status:`${ok}/${chainResults.length} networks scanned successfully`,totalObserved:addresses.length,addresses,chains:chainResults,notes:'Recent-block sample only; not a historical wallet index. Last observed is not proof of wallet inactivity or abandonment.'};
await fs.writeFile(OUT,JSON.stringify(data,null,2)+'\n');
console.log(data.status, `— ${addresses.length} unique observed addresses`);
if(ok===0) process.exitCode=1;
