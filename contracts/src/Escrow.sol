// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "lib/forge-std/src/interfaces/IERC20.sol";
import {ReentrancyGuard} from "lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

/// @title Agent Escrow Protocol
/// @notice Settlement layer for agent-to-agent commerce
/// @dev V1: Protocol-controlled arbitration, ETH/USDC payments
contract Escrow is ReentrancyGuard {
    // ============ Enums ============

    enum EscrowState {
        PENDING,    // Created, awaiting worker acceptance
        ACTIVE,     // Worker accepted, work in progress
        SUBMITTED,  // Worker submitted deliverable
        DISPUTED,   // Client disputed, awaiting arbitration
        RESOLVED,   // Completed (released, refunded, or arbitrated)
        CANCELLED   // Cancelled before acceptance
    }

    // ============ Structs ============

    struct EscrowData {
        address client;
        address worker;
        address arbiter;
        address token;           // address(0) for ETH
        uint256 amount;
        uint256 deadline;
        bytes32 criteriaHash;    // IPFS CID of success criteria
        bytes32 evidenceHash;    // IPFS CID of submitted evidence
        EscrowState state;
        uint256 createdAt;
        uint256 submittedAt;
    }

    // ============ State Variables ============

    /// @notice Mapping of escrow ID to escrow data
    mapping(bytes32 => EscrowData) public escrows;

    /// @notice Counter for generating unique escrow IDs
    uint256 private _escrowCounter;

    /// @notice Protocol-controlled arbiter address (Phase 0)
    address public protocolArbiter;

    /// @notice Protocol owner
    address public owner;

    /// @notice Minimum escrow amount
    uint256 public constant MIN_ESCROW = 0.001 ether;

    /// @notice Maximum escrow amount (V1 risk limit)
    uint256 public constant MAX_ESCROW = 5 ether;

    /// @notice Client review timeout (4 hours)
    uint256 public constant REVIEW_TIMEOUT = 4 hours;

    /// @notice Arbitrator fee percentage (5%)
    uint256 public constant ARBITER_FEE_BPS = 500;

    /// @notice Dispute fee percentage (1%)
    uint256 public constant DISPUTE_FEE_BPS = 100;

    /// @notice Basis points denominator
    uint256 public constant BPS_DENOMINATOR = 10000;

    // ============ Events ============

    event EscrowCreated(
        bytes32 indexed escrowId,
        address indexed client,
        address indexed worker,
        uint256 amount,
        bytes32 criteriaHash
    );

    event EscrowAccepted(bytes32 indexed escrowId, address indexed worker);

    event DeliverableSubmitted(
        bytes32 indexed escrowId,
        bytes32 evidenceHash
    );

    event PaymentReleased(
        bytes32 indexed escrowId,
        address indexed worker,
        uint256 amount
    );

    event EscrowDisputed(
        bytes32 indexed escrowId,
        address indexed disputer,
        bytes32 reasonHash
    );

    event DisputeResolved(
        bytes32 indexed escrowId,
        address indexed arbiter,
        uint256 workerPct,
        uint256 workerAmount,
        uint256 clientAmount
    );

    event EscrowCancelled(bytes32 indexed escrowId);

    event EscrowExpired(bytes32 indexed escrowId);

    // ============ Errors ============

    error InvalidAmount();
    error InvalidWorker();
    error InvalidDeadline();
    error EscrowNotFound();
    error InvalidState();
    error NotAuthorized();
    error TransferFailed();
    error DeadlinePassed();
    error ReviewPeriodActive();
    error InvalidPercentage();

    // ============ Modifiers ============

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotAuthorized();
        _;
    }

    modifier onlyArbiter() {
        if (msg.sender != protocolArbiter) revert NotAuthorized();
        _;
    }

    modifier escrowExists(bytes32 escrowId) {
        if (escrows[escrowId].client == address(0)) revert EscrowNotFound();
        _;
    }

    modifier inState(bytes32 escrowId, EscrowState expectedState) {
        if (escrows[escrowId].state != expectedState) revert InvalidState();
        _;
    }

    // ============ Constructor ============

    constructor(address _protocolArbiter) {
        owner = msg.sender;
        protocolArbiter = _protocolArbiter;
    }

    // ============ External Functions ============

    /// @notice Create a new escrow
    /// @param worker Address of the worker agent
    /// @param deadline Unix timestamp for task deadline
    /// @param criteriaHash IPFS CID of success criteria JSON
    /// @return escrowId Unique identifier for the escrow
    function createEscrow(
        address worker,
        uint256 deadline,
        bytes32 criteriaHash
    ) external payable nonReentrant returns (bytes32 escrowId) {
        if (msg.value < MIN_ESCROW || msg.value > MAX_ESCROW) revert InvalidAmount();
        if (worker == address(0) || worker == msg.sender) revert InvalidWorker();
        if (deadline <= block.timestamp) revert InvalidDeadline();

        escrowId = _generateEscrowId();

        escrows[escrowId] = EscrowData({
            client: msg.sender,
            worker: worker,
            arbiter: protocolArbiter,
            token: address(0), // ETH
            amount: msg.value,
            deadline: deadline,
            criteriaHash: criteriaHash,
            evidenceHash: bytes32(0),
            state: EscrowState.PENDING,
            createdAt: block.timestamp,
            submittedAt: 0
        });

        emit EscrowCreated(escrowId, msg.sender, worker, msg.value, criteriaHash);
    }

    /// @notice Create escrow with ERC20 token
    /// @param worker Address of the worker agent
    /// @param token ERC20 token address
    /// @param amount Amount of tokens to escrow
    /// @param deadline Unix timestamp for task deadline
    /// @param criteriaHash IPFS CID of success criteria JSON
    /// @return escrowId Unique identifier for the escrow
    function createEscrowERC20(
        address worker,
        address token,
        uint256 amount,
        uint256 deadline,
        bytes32 criteriaHash
    ) external nonReentrant returns (bytes32 escrowId) {
        if (amount == 0) revert InvalidAmount();
        if (worker == address(0) || worker == msg.sender) revert InvalidWorker();
        if (deadline <= block.timestamp) revert InvalidDeadline();

        // Transfer tokens to contract
        bool success = IERC20(token).transferFrom(msg.sender, address(this), amount);
        if (!success) revert TransferFailed();

        escrowId = _generateEscrowId();

        escrows[escrowId] = EscrowData({
            client: msg.sender,
            worker: worker,
            arbiter: protocolArbiter,
            token: token,
            amount: amount,
            deadline: deadline,
            criteriaHash: criteriaHash,
            evidenceHash: bytes32(0),
            state: EscrowState.PENDING,
            createdAt: block.timestamp,
            submittedAt: 0
        });

        emit EscrowCreated(escrowId, msg.sender, worker, amount, criteriaHash);
    }

    /// @notice Worker accepts the escrow task
    /// @param escrowId The escrow to accept
    function acceptEscrow(bytes32 escrowId)
        external
        escrowExists(escrowId)
        inState(escrowId, EscrowState.PENDING)
    {
        EscrowData storage escrow = escrows[escrowId];

        if (msg.sender != escrow.worker) revert NotAuthorized();
        if (block.timestamp > escrow.deadline) revert DeadlinePassed();

        escrow.state = EscrowState.ACTIVE;

        emit EscrowAccepted(escrowId, msg.sender);
    }

    /// @notice Worker submits deliverable with evidence
    /// @param escrowId The escrow to submit for
    /// @param evidenceHash IPFS CID of evidence/deliverable
    function submitDeliverable(bytes32 escrowId, bytes32 evidenceHash)
        external
        escrowExists(escrowId)
        inState(escrowId, EscrowState.ACTIVE)
    {
        EscrowData storage escrow = escrows[escrowId];

        if (msg.sender != escrow.worker) revert NotAuthorized();

        escrow.evidenceHash = evidenceHash;
        escrow.state = EscrowState.SUBMITTED;
        escrow.submittedAt = block.timestamp;

        emit DeliverableSubmitted(escrowId, evidenceHash);
    }

    /// @notice Client releases payment to worker (approves delivery)
    /// @param escrowId The escrow to release
    function releasePayment(bytes32 escrowId)
        external
        nonReentrant
        escrowExists(escrowId)
        inState(escrowId, EscrowState.SUBMITTED)
    {
        EscrowData storage escrow = escrows[escrowId];

        if (msg.sender != escrow.client) revert NotAuthorized();

        escrow.state = EscrowState.RESOLVED;

        _transferFunds(escrow.token, escrow.worker, escrow.amount);

        emit PaymentReleased(escrowId, escrow.worker, escrow.amount);
    }

    /// @notice Client disputes the submitted deliverable
    /// @param escrowId The escrow to dispute
    /// @param reasonHash IPFS CID of dispute reason
    function dispute(bytes32 escrowId, bytes32 reasonHash)
        external
        escrowExists(escrowId)
        inState(escrowId, EscrowState.SUBMITTED)
    {
        EscrowData storage escrow = escrows[escrowId];

        if (msg.sender != escrow.client) revert NotAuthorized();
        if (block.timestamp > escrow.submittedAt + REVIEW_TIMEOUT) revert ReviewPeriodActive();

        escrow.state = EscrowState.DISPUTED;

        emit EscrowDisputed(escrowId, msg.sender, reasonHash);
    }

    /// @notice Arbiter resolves a disputed escrow
    /// @param escrowId The escrow to resolve
    /// @param workerPct Percentage (0-100) to pay to worker
    function resolveDispute(bytes32 escrowId, uint256 workerPct)
        external
        nonReentrant
        onlyArbiter
        escrowExists(escrowId)
        inState(escrowId, EscrowState.DISPUTED)
    {
        if (workerPct > 100) revert InvalidPercentage();

        EscrowData storage escrow = escrows[escrowId];

        escrow.state = EscrowState.RESOLVED;

        // Calculate splits
        uint256 arbiterFee = (escrow.amount * ARBITER_FEE_BPS) / BPS_DENOMINATOR;
        uint256 remaining = escrow.amount - arbiterFee;
        uint256 workerAmount = (remaining * workerPct) / 100;
        uint256 clientAmount = remaining - workerAmount;

        // Transfer funds
        if (arbiterFee > 0) {
            _transferFunds(escrow.token, escrow.arbiter, arbiterFee);
        }
        if (workerAmount > 0) {
            _transferFunds(escrow.token, escrow.worker, workerAmount);
        }
        if (clientAmount > 0) {
            _transferFunds(escrow.token, escrow.client, clientAmount);
        }

        emit DisputeResolved(escrowId, msg.sender, workerPct, workerAmount, clientAmount);
    }

    /// @notice Cancel escrow before worker accepts (client only)
    /// @param escrowId The escrow to cancel
    function cancelEscrow(bytes32 escrowId)
        external
        nonReentrant
        escrowExists(escrowId)
        inState(escrowId, EscrowState.PENDING)
    {
        EscrowData storage escrow = escrows[escrowId];

        if (msg.sender != escrow.client) revert NotAuthorized();

        escrow.state = EscrowState.CANCELLED;

        _transferFunds(escrow.token, escrow.client, escrow.amount);

        emit EscrowCancelled(escrowId);
    }

    /// @notice Claim expired escrow after review timeout (worker)
    /// @param escrowId The escrow to claim
    function claimExpiredEscrow(bytes32 escrowId)
        external
        nonReentrant
        escrowExists(escrowId)
        inState(escrowId, EscrowState.SUBMITTED)
    {
        EscrowData storage escrow = escrows[escrowId];

        if (msg.sender != escrow.worker) revert NotAuthorized();
        if (block.timestamp <= escrow.submittedAt + REVIEW_TIMEOUT) revert ReviewPeriodActive();

        escrow.state = EscrowState.RESOLVED;

        _transferFunds(escrow.token, escrow.worker, escrow.amount);

        emit EscrowExpired(escrowId);
        emit PaymentReleased(escrowId, escrow.worker, escrow.amount);
    }

    // ============ View Functions ============

    /// @notice Get escrow details
    /// @param escrowId The escrow to query
    /// @return EscrowData struct
    function getEscrow(bytes32 escrowId) external view returns (EscrowData memory) {
        return escrows[escrowId];
    }

    /// @notice Check if escrow exists
    /// @param escrowId The escrow to check
    /// @return bool True if exists
    function escrowExistsCheck(bytes32 escrowId) external view returns (bool) {
        return escrows[escrowId].client != address(0);
    }

    // ============ Admin Functions ============

    /// @notice Update protocol arbiter (Phase 0 → Phase 1 transition)
    /// @param newArbiter New arbiter address
    function setProtocolArbiter(address newArbiter) external onlyOwner {
        protocolArbiter = newArbiter;
    }

    /// @notice Transfer ownership
    /// @param newOwner New owner address
    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    // ============ Internal Functions ============

    /// @notice Generate unique escrow ID
    /// @return bytes32 Unique ID
    function _generateEscrowId() internal returns (bytes32) {
        return keccak256(abi.encodePacked(block.timestamp, msg.sender, _escrowCounter++));
    }

    /// @notice Transfer ETH or ERC20
    /// @param token Token address (address(0) for ETH)
    /// @param to Recipient
    /// @param amount Amount to transfer
    function _transferFunds(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            (bool success, ) = to.call{value: amount}("");
            if (!success) revert TransferFailed();
        } else {
            bool success = IERC20(token).transfer(to, amount);
            if (!success) revert TransferFailed();
        }
    }
}
