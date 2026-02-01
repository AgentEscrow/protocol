import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import { escrowRoutes } from './routes/escrow.js';
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

## Endpoints

### Create Escrow
\`POST /escrow/create\`

Request:
\`\`\`json
{
  "worker": "0x1234...",
  "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "amount": "100000000",
  "deadline": 1706918400,
  "criteriaHash": "QmXyz..."
}
\`\`\`

Response:
\`\`\`json
{
  "escrowId": "0xabc...",
  "txHash": "0xdef..."
}
\`\`\`

### Accept Escrow (Worker)
\`POST /escrow/:id/accept\`

### Submit Work (Worker)
\`POST /escrow/:id/submit\`
\`\`\`json
{
  "evidenceHash": "QmXyz..."
}
\`\`\`

### Release Payment (Client)
\`POST /escrow/:id/release\`

### Dispute (Client)
\`POST /escrow/:id/dispute\`

### Get Escrow Status
\`GET /escrow/:id\`

Response:
\`\`\`json
{
  "id": "0xabc...",
  "client": "0x...",
  "worker": "0x...",
  "amount": "100000000",
  "state": "Active",
  "criteriaHash": "QmXyz...",
  "evidenceHash": null
}
\`\`\`

## Supported Tokens
- USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
- ETH: Use address(0) or "ETH"

## Fees
- Protocol fee: 1% on all escrows
- Dispute fee: 1% to file a dispute
- Arbitration fee: 5% on disputed escrows

## Limits
- Minimum: $10 USDC
- Maximum: $5,000 USDC

## Need Help?
Contact: https://twitter.com/0xagentescrow
`;

  return c.text(skillContent, 200, {
    'Content-Type': 'text/markdown',
  });
});

// Routes
app.route('/escrow', escrowRoutes);
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
