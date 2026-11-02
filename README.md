# LostCoin Hunter — read-only MVP

## What this build does
- Samples a small number of recent public blocks on Ethereum, BNB Chain, Polygon, Solana and Bitcoin.
- Extracts public addresses appearing in those transactions.
- Stores first/last observed times, sightings and best-effort public balance snapshots.
- Marks an observed address as "inactive 180+ days" only if its last observation in this app is older than 180 days.

## What it does NOT do
- It does not prove that a wallet is abandoned.
- It does not discover every dormant wallet worldwide. That requires historical full-chain indexing and substantial infrastructure.
- It does not access seed phrases/private keys, bypass wallet security, or move funds.
- It does not turn another person's inactive balance into recoverable money.
- A balance snapshot is not income, and public balances may be stale or incomplete.

## Requirements
- Node.js 20 or newer.
- Internet access to public RPC/explorer endpoints.

## Run locally
1. Unzip the project.
2. In the project folder, run `npm start`.
3. Open `http://localhost:3000` in a browser.
4. Optional: copy `.env.example` to `.env` and configure variables in your hosting environment. Node does not load `.env` automatically; export the variables in your shell or use your hosting provider's environment-variable settings.

No npm packages are required.

## Important deployment note
This is a starter MVP, not a production-grade chain indexer. Public RPC services impose rate limits and can change availability. For continuous, broad historical discovery, deploy a backend worker with paid archival/indexing providers, durable database storage, queueing, monitoring, retries, and provider-specific compliance. Do not expose private keys or seed phrases to this service.
