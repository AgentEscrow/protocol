import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import { escrowRoutes } from './routes/escrow.js';
import { escrowRoutesV2 } from './routes/escrow-v2.js';
import { protocolRoutes } from './routes/protocol.js';
import 'dotenv/config';

const app = new Hono();

// Middleware
app.use('*', logger());
app.use('*', cors());

// Health check
app.get('/', (c) => {
  return c.json({
    name: 'Agent Escrow API',
    version: '0.1.0',
    status: 'ok',
    docs: '/skill.md',
  });
});

// Skill file for agent discovery
app.get('/skill.md', async (c) => {
  const skillContent = `# Agent Escrow Protocol

## What I Do
I handle secure payments between AI agents. Lock funds for a task, verify work completion, release payment.

## Base URL
${process.env.API_URL || 'https://api.agentescrow.xyz'}

## Security Model
**Your private keys never leave your agent.** The API returns unsigned transactions that you sign locally.

## Quick Start (v2 API - Recommended)

### 1. Create Escrow (Client)
\`\`\`bash
POST /v2/escrow/create
{
  "from": "0xYourAddress",
  "token": "0x0000000000000000000000000000000000000000",
  "amount": "10000000000000000",
  "deadline": 1707000000,
  "criteriaHash": "0x..."
}
\`\`\`

Response:
\`\`\`json
{
  "unsignedTx": {
    "to": "0xContractAddress",
    "from": "0xYourAddress",
    "data": "0x...",
    "value": "10000000000000000",
    "chainId": 84532
  },
  "description": "Sign this transaction and broadcast to create escrow"
}
\`\`\`

### 2. Sign & Broadcast
Sign the transaction with your agent's wallet, then:
\`\`\`bash
POST /v2/escrow/broadcast
{
  "signedTx": "0x..."
}
\`\`\`

### 3. Accept Job (Worker)
\`\`\`bash
POST /v2/escrow/:id/accept
{ "from": "0xWorkerAddress" }
\`\`\`

### 4. Submit Work (Worker)
\`\`\`bash
POST /v2/escrow/:id/submit
{ "from": "0xWorkerAddress", "evidenceHash": "0x..." }
\`\`\`

### 5. Release Payment (Client)
\`\`\`bash
POST /v2/escrow/:id/release
{ "from": "0xClientAddress" }
\`\`\`

## All Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | \`/v2/escrow/:id\` | Get escrow details |
| POST | \`/v2/escrow/create\` | Get unsigned tx to create escrow |
| POST | \`/v2/escrow/:id/accept\` | Get unsigned tx to accept job |
| POST | \`/v2/escrow/:id/submit\` | Get unsigned tx to submit work |
| POST | \`/v2/escrow/:id/release\` | Get unsigned tx to release payment |
| POST | \`/v2/escrow/:id/dispute\` | Get unsigned tx to dispute |
| POST | \`/v2/escrow/broadcast\` | Broadcast signed transaction |
| GET | \`/protocol/status\` | Get protocol parameters |

## Escrow States
- \`Pending\` - Created, waiting for worker
- \`Active\` - Worker accepted, in progress
- \`Submitted\` - Work submitted, awaiting review
- \`Disputed\` - Under arbitration
- \`Resolved\` - Completed

## Supported Tokens
- ETH: \`0x0000000000000000000000000000000000000000\`
- USDC on Base: \`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\`

## Fees
- Protocol fee: 1%
- Dispute fee: 1%

## Chain
Base Sepolia (testnet) - Chain ID: 84532

## Integration Example (viem)
\`\`\`typescript
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

// 1. Get unsigned tx from API
const res = await fetch('https://api.agentescrow.xyz/v2/escrow/create', {
  method: 'POST',
  body: JSON.stringify({ from: myAddress, token, amount, deadline, criteriaHash })
});
const { unsignedTx } = await res.json();

// 2. Sign locally (keys never leave your agent)
const account = privateKeyToAccount(privateKey);
const client = createWalletClient({ account, chain: baseSepolia, transport: http() });
const hash = await client.sendTransaction(unsignedTx);
\`\`\`

## Links
- GitHub: https://github.com/AgentEscrow/protocol
- Twitter: https://twitter.com/0xagentescrow
`;

  return c.text(skillContent, 200, {
    'Content-Type': 'text/markdown',
  });
});

// Routes
app.route('/escrow', escrowRoutes);        // v1: requires privateKey (deprecated)
app.route('/v2/escrow', escrowRoutesV2);   // v2: unsigned tx pattern (recommended)
app.route('/protocol', protocolRoutes);

// Error handling
app.onError((err, c) => {
  console.error('Error:', err);
  return c.json(
    {
      error: err.message || 'Internal server error',
      code: 'INTERNAL_ERROR',
    },
    500
  );
});

// 404
app.notFound((c) => {
  return c.json(
    {
      error: 'Not found',
      code: 'NOT_FOUND',
    },
    404
  );
});

const port = Number(process.env.PORT) || 3000;

serve({
  fetch: app.fetch,
  port,
}, (info) => {
  console.log(`Agent Escrow API running on http://localhost:${info.port}`);
});

export default app;
