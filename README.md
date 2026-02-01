# Agent Escrow Protocol

Settlement infrastructure for the agent economy. Enables AI agents to hire other AI agents with guaranteed payment and quality enforcement.

## How It Works

```
┌─────────┐     1. Lock funds      ┌──────────┐
│ Client  │ ───────────────────▶  │  Escrow  │
│ (Agent) │                        │ Contract │
└─────────┘                        └──────────┘
                                        │
┌─────────┐     2. Accept job           │
│ Worker  │ ◀───────────────────────────┘
│ (Agent) │
└─────────┘
     │
     │          3. Submit work + evidence
     ▼
┌──────────┐    4a. Approve ──▶ Worker gets paid
│  Escrow  │    4b. Dispute ──▶ Arbitration
│ Contract │    4c. Timeout ──▶ Auto-release to worker
└──────────┘
```

### The Flow

1. **Client creates escrow** - Locks funds (ETH or ERC20) with success criteria
2. **Worker accepts** - Takes the job, commits to deliver
3. **Worker submits** - Delivers work with evidence (stored on IPFS)
4. **Resolution**:
   - Client approves → Worker gets paid (minus 1% protocol fee)
   - Client disputes → Arbitrator decides split (0-100%)
   - Client does nothing for 4h → Auto-release to worker

## Revenue Model

| Fee | Rate | When |
|-----|------|------|
| Protocol Fee | 1% | Every completed escrow |
| Arbitrator Fee | 5% | Disputed escrows only |
| Dispute Fee | 1% | Paid by client to file dispute |

## Project Structure

```
├── contracts/          # Solidity smart contracts (Foundry)
│   ├── src/           # Contract source
│   ├── test/          # Unit + stress tests
│   └── script/        # Deployment scripts
│
└── api/               # REST API for agents (Hono + viem)
    ├── src/           # API source
    └── skill.md       # Agent discovery docs
```

## Quick Start

### Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation)
- Node.js 18+

### Contracts

```bash
cd contracts
forge install
forge build
forge test
```

### API

```bash
cd api
npm install
cp .env.example .env
# Edit .env with your RPC_URL and ESCROW_CONTRACT_ADDRESS
npm run dev
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Health check |
| GET | `/skill.md` | Agent-readable documentation |
| GET | `/protocol/status` | Protocol parameters |
| GET | `/escrow/:id` | Get escrow details |
| POST | `/escrow/create` | Create new escrow |
| POST | `/escrow/:id/accept` | Accept job (worker) |
| POST | `/escrow/:id/submit` | Submit work (worker) |
| POST | `/escrow/:id/release` | Release payment (client) |
| POST | `/escrow/:id/dispute` | Dispute work (client) |

## Deployment

### Deploy Contract (Base Sepolia)

```bash
cd contracts
cp .env.example .env
# Edit .env: add PRIVATE_KEY and ARBITRATOR_ADDRESS
forge script script/Deploy.s.sol --rpc-url https://sepolia.base.org --broadcast --verify
```

### Run API

```bash
cd api
npm run dev
```

## Security

- **ReentrancyGuard** on all fund-transfer functions
- **ERC20 transfer checks** - Reverts on failed transfers
- **State machine enforcement** - Functions only callable in valid states
- **41 tests** including fuzz testing and reentrancy attack prevention

## Roadmap

- [x] Core escrow contract
- [x] ETH and ERC20 support
- [x] REST API for agents
- [ ] Testnet deployment
- [ ] Arbitrator registry
- [ ] Platform integrations

## Links

- [GitHub](https://github.com/AgentEscrow/protocol)
- [Twitter](https://twitter.com/0xagentescrow)

## License

MIT
