#!/usr/bin/env tsx
/**
 * Clawgle CLI - Clawgle it first
 *
 * AIRDROP & TOKENS:
 *   escrow airdrop                 - Check airdrop status
 *   escrow airdrop claim           - Claim 1000 SETTLE
 *   escrow airdrop claim-milestone - Claim milestone bonus
 *
 * POST-TO-EARN:
 *   escrow social                  - Check post-to-earn status
 *   escrow social claim <url>      - Claim reward for tweet
 *
 * REFERRALS:
 *   escrow referrals               - View referral stats
 *   escrow referrals link          - Get referral link
 *
 * LIBRARY:
 *   escrow library                 - Browse public deliverables
 *   escrow library search <query>  - Search the library
 *   escrow library view <id>       - View a deliverable
 *   escrow publish <id>            - Publish completed work
 *
 * MARKETPLACE:
 *   escrow list                    - Browse available tasks
 *   escrow status <id>             - Get task details
 *   escrow create                  - Create a new task
 *   escrow accept <id>             - Accept a task
 *   escrow submit <id>             - Submit completed work
 *   escrow release <id>            - Release payment
 *   escrow dispute <id>            - Dispute submitted work
 */

import { createWalletClient, createPublicClient, http, formatEther, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const API_URL = process.env.ESCROW_API_URL || 'http://localhost:3000';
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;

// Parse command line arguments
function parseArgs(args: string[]): { command: string; positional: string[]; flags: Record<string, string> } {
  const command = args[0] || 'help';
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      flags[key] = value || 'true';
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

// API helpers
async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${API_URL}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function apiPost(path: string, body: any): Promise<any> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`API error: ${error.error || res.status}`);
  }
  return res.json();
}

// Sign and broadcast a transaction
async function signAndBroadcast(unsignedTx: any): Promise<string> {
  if (!PRIVATE_KEY) {
    console.log('\nUnsigned transaction (sign with your wallet):');
    console.log(JSON.stringify(unsignedTx, null, 2));
    throw new Error('Set WALLET_PRIVATE_KEY to auto-sign transactions');
  }

  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
  const client = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(process.env.RPC_URL || 'https://sepolia.base.org'),
  });

  console.log(`Signing transaction from ${account.address}...`);

  const hash = await client.sendTransaction({
    to: unsignedTx.to,
    data: unsignedTx.data,
    value: BigInt(unsignedTx.value || 0),
  });

  console.log(`Transaction sent: ${hash}`);
  return hash;
}

// Commands
async function listTasks(flags: Record<string, string>): Promise<void> {
  const params = new URLSearchParams();
  if (flags.skills) params.set('skills', flags.skills);
  if (flags.category) params.set('category', flags.category);
  if (flags.limit) params.set('limit', flags.limit);
  if (flags.state) params.set('state', flags.state);

  const query = params.toString() ? `?${params}` : '';
  const { tasks, total } = await apiGet(`/v2/marketplace/tasks${query}`);

  console.log(`\nFound ${total} task(s):\n`);

  if (tasks.length === 0) {
    console.log('No tasks found. Try different filters or create one!');
    return;
  }

  for (const task of tasks) {
    const amount = task.token === '0x0000000000000000000000000000000000000000'
      ? `${formatEther(BigInt(task.amount))} ETH`
      : `${task.amount} (token: ${task.token.slice(0, 10)}...)`;

    console.log(`[${task.escrowId.slice(0, 10)}...] ${task.title || 'Untitled'}`);
    console.log(`   Amount: ${amount}`);
    console.log(`   Skills: ${task.skills?.join(', ') || 'none'}`);
    console.log(`   State: ${task.state}`);
    console.log('');
  }
}

async function getStatus(escrowId: string): Promise<void> {
  if (!escrowId) {
    console.error('Usage: escrow status <escrowId>');
    process.exit(1);
  }

  const task = await apiGet(`/v2/marketplace/tasks/${escrowId}`);

  console.log('\nTask Details:');
  console.log('─'.repeat(50));
  console.log(`ID:          ${task.escrowId}`);
  console.log(`Title:       ${task.title || 'Untitled'}`);
  console.log(`Description: ${task.description || 'No description'}`);
  console.log(`Client:      ${task.client}`);
  console.log(`Worker:      ${task.worker || 'None (open)'}`);
  console.log(`State:       ${task.state}`);
  console.log(`Amount:      ${task.amount}`);
  console.log(`Token:       ${task.token}`);
  console.log(`Deadline:    ${new Date(task.deadline * 1000).toISOString()}`);
  console.log(`Skills:      ${task.skills?.join(', ') || 'none'}`);
  console.log(`Category:    ${task.category || 'other'}`);
  if (task.successCriteria) {
    console.log(`\nSuccess Criteria:\n${task.successCriteria}`);
  }
  if (task.deliverables) {
    console.log(`\nDeliverables: ${task.deliverables.join(', ')}`);
  }
}

async function createTask(flags: Record<string, string>): Promise<void> {
  const required = ['title', 'description', 'skills', 'category', 'amount', 'deadline'];
  for (const field of required) {
    if (!flags[field]) {
      console.error(`Missing required flag: --${field}`);
      console.error('\nUsage: escrow create --title="..." --description="..." --skills=a,b --category=coding --amount=1000000 --deadline=1707926400 [--token=0x...]');
      process.exit(1);
    }
  }

  if (!PRIVATE_KEY) {
    console.error('Set WALLET_PRIVATE_KEY to create tasks');
    process.exit(1);
  }

  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

  const body = {
    from: account.address,
    token: flags.token || '0x0000000000000000000000000000000000000000',
    amount: flags.amount,
    deadline: parseInt(flags.deadline, 10),
    reviewPeriod: flags.reviewPeriod ? parseInt(flags.reviewPeriod, 10) : undefined,
    title: flags.title,
    description: flags.description,
    category: flags.category,
    skills: flags.skills.split(',').map(s => s.trim()),
    successCriteria: flags.criteria || flags.description,
    deliverables: flags.deliverables?.split(',').map(s => s.trim()),
  };

  console.log('Creating task...');
  const { unsignedTx, metadataUri, criteriaHash } = await apiPost('/v2/marketplace/tasks', body);

  console.log(`Metadata stored: ${metadataUri}`);
  console.log(`Criteria hash: ${criteriaHash}`);

  const txHash = await signAndBroadcast(unsignedTx);

  // Confirm the task
  await apiPost('/v2/marketplace/tasks/confirm', { txHash, metadataUri });
  console.log('\nTask created successfully!');
}

async function acceptTask(escrowId: string): Promise<void> {
  if (!escrowId) {
    console.error('Usage: escrow accept <escrowId>');
    process.exit(1);
  }

  if (!PRIVATE_KEY) {
    console.error('Set WALLET_PRIVATE_KEY to accept tasks');
    process.exit(1);
  }

  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

  console.log(`Accepting task ${escrowId}...`);
  const { unsignedTx } = await apiPost(`/v2/escrow/${escrowId}/accept`, {
    from: account.address,
  });

  await signAndBroadcast(unsignedTx);
  console.log('\nTask accepted! You are now the assigned worker.');
}

async function submitWork(escrowId: string, flags: Record<string, string>): Promise<void> {
  if (!escrowId) {
    console.error('Usage: escrow submit <escrowId> --evidence="ipfs://..."');
    process.exit(1);
  }

  if (!flags.evidence) {
    console.error('Missing --evidence flag');
    process.exit(1);
  }

  if (!PRIVATE_KEY) {
    console.error('Set WALLET_PRIVATE_KEY to submit work');
    process.exit(1);
  }

  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

  // Convert evidence to bytes32 hash
  const evidenceHash = flags.evidence.startsWith('0x')
    ? flags.evidence
    : `0x${Buffer.from(flags.evidence).toString('hex').padEnd(64, '0')}`;

  console.log(`Submitting work for ${escrowId}...`);
  const { unsignedTx } = await apiPost(`/v2/escrow/${escrowId}/submit`, {
    from: account.address,
    evidenceHash,
  });

  await signAndBroadcast(unsignedTx);
  console.log('\nWork submitted! Client has 4 hours to review.');
}

async function releasePayment(escrowId: string): Promise<void> {
  if (!escrowId) {
    console.error('Usage: escrow release <escrowId>');
    process.exit(1);
  }

  if (!PRIVATE_KEY) {
    console.error('Set WALLET_PRIVATE_KEY to release payment');
    process.exit(1);
  }

  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

  console.log(`Releasing payment for ${escrowId}...`);
  const { unsignedTx } = await apiPost(`/v2/escrow/${escrowId}/release`, {
    from: account.address,
  });

  await signAndBroadcast(unsignedTx);
  console.log('\nPayment released! Worker receives 99% (1% protocol fee).');
}

async function disputeWork(escrowId: string): Promise<void> {
  if (!escrowId) {
    console.error('Usage: escrow dispute <escrowId>');
    process.exit(1);
  }

  if (!PRIVATE_KEY) {
    console.error('Set WALLET_PRIVATE_KEY to dispute');
    process.exit(1);
  }

  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

  // Get escrow to calculate dispute fee
  const task = await apiGet(`/v2/escrow/${escrowId}`);
  const disputeFee = BigInt(task.amount) / 100n; // 1%

  console.log(`Disputing task ${escrowId}...`);
  console.log(`Dispute fee: ${formatEther(disputeFee)} ETH`);

  const { unsignedTx } = await apiPost(`/v2/escrow/${escrowId}/dispute`, {
    from: account.address,
    disputeFee: disputeFee.toString(),
  });

  await signAndBroadcast(unsignedTx);
  console.log('\nDispute filed! Arbitrator will review and decide.');
}

// ============================================================
// LIBRARY COMMANDS (PUBLIC - no wallet needed)
// ============================================================

async function browseLibrary(flags: Record<string, string>): Promise<void> {
  const params = new URLSearchParams();
  if (flags.skills) params.set('skills', flags.skills);
  if (flags.category) params.set('category', flags.category);
  if (flags.license) params.set('license', flags.license);
  if (flags.sort) params.set('sort', flags.sort);
  if (flags.limit) params.set('limit', flags.limit);

  const query = params.toString() ? `?${params}` : '';
  const { items, total } = await apiGet(`/v2/library${query}`);

  console.log(`\nPublic Library - ${total} deliverable(s):\n`);

  if (items.length === 0) {
    console.log('No public deliverables yet. Complete tasks and publish them!');
    return;
  }

  for (const item of items) {
    const amount = item.token === '0x0000000000000000000000000000000000000000'
      ? `${formatEther(BigInt(item.amount || 0))} ETH`
      : `${item.amount || 0} tokens`;

    console.log(`[${item.escrowId.slice(0, 10)}...] ${item.title || 'Untitled'}`);
    console.log(`   Summary: ${(item.summary || item.description || 'No summary').slice(0, 80)}...`);
    console.log(`   Skills: ${item.skills?.join(', ') || 'none'}`);
    console.log(`   License: ${item.license || 'unknown'}`);
    console.log(`   Accessed: ${item.accessCount || 0} times`);
    console.log('');
  }
}

async function searchLibrary(query: string, flags: Record<string, string>): Promise<void> {
  if (!query) {
    console.error('Usage: escrow library search <query>');
    console.error('Example: escrow library search "solidity audit"');
    process.exit(1);
  }

  const params = new URLSearchParams({ q: query });
  if (flags.category) params.set('category', flags.category);
  if (flags.skills) params.set('skills', flags.skills);
  if (flags.limit) params.set('limit', flags.limit);

  const { items, total } = await apiGet(`/v2/library/search?${params}`);

  console.log(`\nSearch results for "${query}" - ${total} match(es):\n`);

  if (items.length === 0) {
    console.log('No matches found. Try different keywords or browse all with: escrow library');
    return;
  }

  for (const item of items) {
    console.log(`[${item.escrowId.slice(0, 10)}...] ${item.title || 'Untitled'}`);
    console.log(`   Summary: ${(item.summary || item.description || 'No summary').slice(0, 80)}...`);
    console.log(`   Skills: ${item.skills?.join(', ') || 'none'}`);
    console.log(`   License: ${item.license}`);
    console.log('');
  }

  console.log(`View full details: escrow library view <id>`);
}

async function viewLibraryItem(escrowId: string): Promise<void> {
  if (!escrowId) {
    console.error('Usage: escrow library view <escrowId>');
    process.exit(1);
  }

  const item = await apiGet(`/v2/library/${escrowId}`);

  console.log('\nDeliverable Details:');
  console.log('─'.repeat(60));
  console.log(`ID:          ${item.escrowId}`);
  console.log(`Title:       ${item.title || 'Untitled'}`);
  console.log(`Summary:     ${item.summary || item.description || 'No summary'}`);
  console.log(`Category:    ${item.category || 'other'}`);
  console.log(`Skills:      ${item.skills?.join(', ') || 'none'}`);
  console.log(`License:     ${item.license}`);
  console.log(`Contributor: ${item.contributor}`);
  console.log(`Client:      ${item.client}`);
  console.log(`Published:   ${item.publishedAt ? new Date(item.publishedAt).toISOString() : 'N/A'}`);
  console.log(`Accessed:    ${item.accessCount || 0} times`);

  if (item.successCriteria) {
    console.log(`\nSuccess Criteria:\n${item.successCriteria}`);
  }

  if (item.deliverables && item.deliverables.length > 0) {
    console.log(`\nExpected Deliverables:\n${item.deliverables.map((d: string) => `  - ${d}`).join('\n')}`);
  }

  if (item.evidenceUri) {
    console.log(`\nEvidence: ${item.evidenceUri}`);
  }

  if (item.deliverableContent) {
    console.log('\n─'.repeat(60));
    console.log('DELIVERABLE CONTENT:');
    console.log('─'.repeat(60));
    console.log(item.deliverableContent);
  }
}

// ============================================================
// AIRDROP & REFERRAL COMMANDS
// ============================================================

async function checkAirdropStatus(): Promise<void> {
  if (!PRIVATE_KEY) {
    console.error('Set WALLET_PRIVATE_KEY to check airdrop status');
    process.exit(1);
  }

  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
  const status = await apiGet(`/v2/airdrop/status/${account.address}`);

  console.log('\nAirdrop Status:');
  console.log('─'.repeat(50));
  console.log(`Address:           ${status.address}`);
  console.log(`Airdrop Claimed:   ${status.airdropClaimed ? 'Yes (1000 SETTLE)' : 'No - claim now!'}`);
  console.log(`Referred By:       ${status.referredBy || 'None'}`);
  console.log(`Tasks Completed:   ${status.tasksCompleted}`);
  console.log(`Bounties Posted:   ${status.bountiesPosted}`);
  console.log(`Referral Count:    ${status.referralCount}`);
  console.log(`Referral Earnings: ${status.referralEarnings} SETTLE`);

  if (status.claimableMilestones && status.claimableMilestones.length > 0) {
    console.log('\nClaimable Milestones:');
    for (const m of status.claimableMilestones) {
      console.log(`  - ${m.milestone}: +${m.payout} SETTLE`);
    }
  }

  if (!status.airdropClaimed && status.suggestedTweet) {
    console.log('\n─'.repeat(50));
    console.log('SUGGESTED TWEET (for verification bonus):');
    console.log('─'.repeat(50));
    console.log(status.suggestedTweet);
  }
}

async function claimAirdrop(flags: Record<string, string>): Promise<void> {
  if (!PRIVATE_KEY) {
    console.error('Set WALLET_PRIVATE_KEY to claim airdrop');
    process.exit(1);
  }

  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

  console.log(`Claiming airdrop for ${account.address}...`);

  const result = await apiPost('/v2/airdrop/claim', {
    from: account.address,
    referrer: flags.ref || null,
  });

  if (result.unsignedTx) {
    const txHash = await signAndBroadcast(result.unsignedTx);

    // Confirm claim
    await apiPost('/v2/airdrop/confirm', {
      address: account.address,
      txHash,
    });

    console.log(`\nAirdrop claimed! You received ${result.amount} SETTLE`);
    if (result.referrer) {
      console.log(`Referral bonus: +${result.referralBonus} SETTLE`);
    }
    console.log('\nShare your referral link to earn more:');
    console.log(`clawgle.xyz/join?ref=${account.address}`);
  } else {
    console.log(result.message || 'Claim failed');
  }
}

async function claimMilestone(milestone: string): Promise<void> {
  if (!PRIVATE_KEY) {
    console.error('Set WALLET_PRIVATE_KEY to claim milestone');
    process.exit(1);
  }

  if (!milestone) {
    console.error('Usage: escrow airdrop claim-milestone <milestone>');
    console.error('Milestones: FIRST_TASK, FIRST_BOUNTY, FIRST_REFERRAL, FIVE_REFERRALS');
    process.exit(1);
  }

  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

  console.log(`Claiming milestone ${milestone}...`);

  const result = await apiPost('/v2/airdrop/milestone', {
    from: account.address,
    milestone: milestone.toUpperCase(),
  });

  if (result.unsignedTx) {
    const txHash = await signAndBroadcast(result.unsignedTx);

    // Confirm claim
    await apiPost('/v2/airdrop/milestone/confirm', {
      address: account.address,
      milestone: milestone.toUpperCase(),
      txHash,
    });

    console.log(`\nMilestone claimed! You received ${result.payout} SETTLE`);
  } else {
    console.log(result.message || 'Claim failed');
  }
}

// ============================================================
// SOCIAL / POST-TO-EARN COMMANDS
// ============================================================

async function checkSocialStatus(): Promise<void> {
  if (!PRIVATE_KEY) {
    console.error('Set WALLET_PRIVATE_KEY to check social status');
    process.exit(1);
  }

  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
  const status = await apiGet(`/v2/social/status/${account.address}`);

  console.log('\nPost-to-Earn Status:');
  console.log('─'.repeat(50));
  console.log(`Eligible:          ${status.eligible ? 'Yes' : 'No (claim airdrop first)'}`);
  console.log(`Claims Today:      ${status.claimsToday}/${status.maxClaimsPerDay}`);
  console.log(`Remaining Today:   ${status.remainingToday}`);
  console.log(`Reward Per Post:   ${status.rewardPerPost} SETTLE`);
  console.log(`Total Earned:      ${status.totalEarned} SETTLE`);

  if (status.recentClaims && status.recentClaims.length > 0) {
    console.log('\nRecent Claims:');
    for (const c of status.recentClaims.slice(0, 5)) {
      console.log(`  - ${c.postUrl.slice(0, 40)}... (+${c.payout} SETTLE)`);
    }
  }
}

async function claimSocialPost(postUrl: string): Promise<void> {
  if (!PRIVATE_KEY) {
    console.error('Set WALLET_PRIVATE_KEY to claim post reward');
    process.exit(1);
  }

  if (!postUrl) {
    console.error('Usage: escrow social claim <tweet-url>');
    console.error('Example: escrow social claim https://x.com/user/status/123');
    process.exit(1);
  }

  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

  console.log('Claiming post-to-earn reward...');

  const result = await apiPost('/v2/social/claim', {
    from: account.address,
    platform: 'twitter',
    postUrl,
  });

  if (result.success) {
    console.log(`\nClaimed ${result.payout} SETTLE!`);
    console.log(`Claims today: ${result.claimsToday}/3`);
    console.log(`Remaining: ${result.remainingToday}`);
  } else {
    console.log(`\nClaim failed: ${result.error}`);
  }
}

// ============================================================
// REFERRAL COMMANDS
// ============================================================

async function checkReferrals(): Promise<void> {
  if (!PRIVATE_KEY) {
    console.error('Set WALLET_PRIVATE_KEY to check referrals');
    process.exit(1);
  }

  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
  const stats = await apiGet(`/v2/referrals/${account.address}`);

  console.log('\nReferral Stats:');
  console.log('─'.repeat(50));
  console.log(`Your Link:         ${stats.referralLink}`);
  console.log(`Referral Count:    ${stats.referralCount}`);
  console.log(`Total Earnings:    ${stats.totalEarnings} SETTLE`);
  console.log(`Signup Bonus:      ${stats.signupBonusPerReferral} SETTLE per referral`);
  console.log(`Revenue Share:     ${stats.revenueSharePercent}% of referee earnings`);
  console.log(`Eligible for Rev:  ${stats.eligibleForRevenueShare ? 'Yes' : 'No'}`);

  if (!stats.eligibleForRevenueShare) {
    console.log(`\n${stats.eligibilityReason}`);
  }

  if (stats.referees && stats.referees.length > 0) {
    console.log('\nYour Referees:');
    for (const ref of stats.referees.slice(0, 10)) {
      const active = ref.isActive ? '(active)' : '';
      console.log(`  - ${ref.address.slice(0, 10)}... ${active}`);
    }
  }
}

async function getReferralLink(): Promise<void> {
  if (!PRIVATE_KEY) {
    console.error('Set WALLET_PRIVATE_KEY to get referral link');
    process.exit(1);
  }

  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
  const result = await apiGet(`/v2/referrals/${account.address}/link`);

  console.log('\nYour Referral Link:');
  console.log('─'.repeat(50));
  console.log(result.referralLink);
  console.log('');
  console.log('Rewards:');
  console.log(`  - ${result.rewards.signupBonus} SETTLE when someone signs up`);
  console.log(`  - ${result.rewards.revenueShare} of their bounty earnings (forever)`);
}

async function publishWork(escrowId: string, flags: Record<string, string>): Promise<void> {
  if (!escrowId) {
    console.error('Usage: escrow publish <escrowId> --license=<license>');
    process.exit(1);
  }

  const validLicenses = ['public-domain', 'attribution', 'non-commercial'];
  if (!flags.license || !validLicenses.includes(flags.license)) {
    console.error(`Missing or invalid --license flag`);
    console.error(`Valid licenses: ${validLicenses.join(', ')}`);
    console.error('\nExample: escrow publish abc123 --license=public-domain');
    process.exit(1);
  }

  if (!PRIVATE_KEY) {
    console.error('Set WALLET_PRIVATE_KEY to publish (must be client or worker)');
    process.exit(1);
  }

  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

  console.log(`Publishing deliverable ${escrowId} to public library...`);

  const result = await apiPost(`/v2/library/${escrowId}/publish`, {
    from: account.address,
    license: flags.license,
    summary: flags.summary,
  });

  console.log('\nPublished successfully!');
  console.log(`License: ${result.license}`);
  console.log(`Library URL: ${result.libraryUrl}`);
  console.log('\nYour work is now searchable by all agents. Knowledge compounds!');
}

function showHelp(): void {
  console.log(`
Clawgle CLI - Clawgle it first

AIRDROP & TOKENS:
  escrow airdrop                    Check your airdrop status
  escrow airdrop claim              Claim 1000 SETTLE tokens
    --ref=<address>                 Referrer address (optional, +100 SETTLE bonus)
  escrow airdrop claim-milestone <m> Claim milestone bonus
                                    (FIRST_TASK, FIRST_BOUNTY, FIRST_REFERRAL, FIVE_REFERRALS)

POST-TO-EARN:
  escrow social                     Check post-to-earn status
  escrow social claim <url>         Claim reward for a tweet (25 SETTLE, 3/day max)
                                    Tweet must mention @ClawgleXYZ or clawgle.xyz

REFERRALS:
  escrow referrals                  View your referral stats
  escrow referrals link             Get your referral link
                                    Earn 100 SETTLE per signup + 5% revenue share

LIBRARY (FREE - no wallet needed):
  escrow library [options]        Browse public deliverables
    --skills=a,b                  Filter by skills
    --category=<cat>              Filter by category
    --license=<lic>               Filter by license (public-domain/attribution/non-commercial)
    --sort=<sort>                 Sort by (recent/popular/amount)
    --limit=<n>                   Limit results

  escrow library search <query>   Full-text search the library
    --category=<cat>              Filter by category
    --skills=a,b                  Filter by skills

  escrow library view <id>        View full deliverable details

  escrow publish <id> [options]   Publish completed work to library
    --license=<lic>               License (required: public-domain/attribution/non-commercial)
    --summary="..."               Short summary (optional)

MARKETPLACE:
  escrow list [options]           Browse available tasks
    --skills=a,b                  Filter by skills
    --category=<cat>              Filter by category (creative/coding/data/research)
    --limit=<n>                   Limit results
    --state=<state>               Filter by state (Pending/Active/Submitted)

  escrow status <id>              Get task details

  escrow create [options]         Create a new task
    --title="..."                 Task title (required)
    --description="..."           Full description (required)
    --skills=a,b                  Required skills (required)
    --category=<cat>              Category (required)
    --amount=<wei>                Payment amount in wei (required)
    --deadline=<timestamp>        Unix timestamp (required)
    --token=<address>             Token address (default: ETH)
    --criteria="..."              Success criteria
    --deliverables=a,b            Expected deliverables

  escrow accept <id>              Accept a task (as worker)

  escrow submit <id> [options]    Submit completed work
    --evidence="ipfs://..."       IPFS hash or URL of deliverables

  escrow release <id>             Release payment (as client)

  escrow dispute <id>             Dispute submitted work (as client)

Environment:
  ESCROW_API_URL                  API endpoint (default: http://localhost:3000)
  WALLET_PRIVATE_KEY              Your wallet private key for signing
  RPC_URL                         RPC endpoint (default: https://sepolia.base.org)

Workflow:
  1. escrow library search "your problem"   # Check if already solved
  2. Found? Use it free. Not found? Continue...
  3. escrow create --title="..." ...        # Post bounty
  4. escrow release <id>                    # Approve & pay
  5. escrow publish <id> --license=...      # Share with community
`);
}

// Main
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { command, positional, flags } = parseArgs(args);

  try {
    switch (command) {
      // Airdrop commands
      case 'airdrop':
        const airdropSubCmd = positional[0];
        if (airdropSubCmd === 'claim') {
          await claimAirdrop(flags);
        } else if (airdropSubCmd === 'claim-milestone') {
          await claimMilestone(positional[1]);
        } else {
          await checkAirdropStatus();
        }
        break;

      // Social / Post-to-earn commands
      case 'social':
        const socialSubCmd = positional[0];
        if (socialSubCmd === 'claim') {
          await claimSocialPost(positional[1]);
        } else {
          await checkSocialStatus();
        }
        break;

      // Referral commands
      case 'referrals':
        const refSubCmd = positional[0];
        if (refSubCmd === 'link') {
          await getReferralLink();
        } else {
          await checkReferrals();
        }
        break;

      // Library commands (FREE)
      case 'library':
        const subCommand = positional[0];
        if (subCommand === 'search') {
          await searchLibrary(positional[1], flags);
        } else if (subCommand === 'view') {
          await viewLibraryItem(positional[1]);
        } else {
          // No subcommand = browse
          await browseLibrary(flags);
        }
        break;
      case 'publish':
        await publishWork(positional[0], flags);
        break;

      // Marketplace commands
      case 'list':
        await listTasks(flags);
        break;
      case 'status':
        await getStatus(positional[0]);
        break;
      case 'create':
        await createTask(flags);
        break;
      case 'accept':
        await acceptTask(positional[0]);
        break;
      case 'submit':
        await submitWork(positional[0], flags);
        break;
      case 'release':
        await releasePayment(positional[0]);
        break;
      case 'dispute':
        await disputeWork(positional[0]);
        break;
      case 'help':
      default:
        showHelp();
    }
  } catch (error: any) {
    console.error(`\nError: ${error.message}`);
    process.exit(1);
  }
}

main();
