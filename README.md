# LostCoin Hunter — GitHub Pages + Actions prototype

This version works without a hosted Node web server. GitHub Pages serves the dashboard; GitHub Actions runs a small read-only public-chain sample every six hours and publishes `data.json` to the repository.

## Install in the repository
1. Keep `index.html` in the repository root (the same folder as `README.md`). Replace it with this version.
2. Add `scripts/scan.js`.
3. Add `.github/workflows/scan.yml`.
4. In GitHub, open **Settings → Actions → General → Workflow permissions**, choose **Read and write permissions**, and save. The workflow needs this permission to commit updated `data.json`.
5. Open **Actions → LostCoin Hunter public scan → Run workflow** to run the first scan. Wait for the run to finish, then refresh the Pages site.

The workflow also runs every six hours. GitHub scheduled workflows can be delayed and may be disabled after long periods of repository inactivity. The dashboard's Refresh button only reloads the published data; it cannot start a GitHub workflow directly without exposing a credential, which this app deliberately does not do.

## Limits and safety
This is a demonstration, not a global chain indexer. Each run samples only a recent block from Ethereum, BNB Chain, Polygon, Bitcoin and Solana where public RPC endpoints respond. Public RPC endpoints may fail or rate-limit. It does not scan historical chain data, verify wallet dormancy, determine ownership, access private keys, or transfer funds. An address appearing in a block is not evidence that its balance is abandoned or recoverable.
