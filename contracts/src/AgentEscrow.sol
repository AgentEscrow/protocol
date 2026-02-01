// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "forge-std/interfaces/IERC20.sol";

/**
 * @title AgentEscrow
 * @notice Settlement infrastructure for agent-to-agent commerce
 * @dev Phase 0: Protocol as sole arbitrator
 */
contract AgentEscrow {
    // =============================================================
    //                           TYPES
    // =============================================================

    enum EscrowState {
        Pending,    // Created, awaiting worker acceptance
        Active,     // Worker accepted, work in progress
        Submitted,  // Worker submitted deliverable
        Disputed,   // Client disputed, awaiting arbitration
        Resolved    // Final state
    }

    enum Outcome {
        None,
        FullRelease,    // 100% to worker
        FullRefund,     // 100% to client
        Partial         // Split based on completionPct
    }

    struct Escrow {
        address client;
        address worker;
        address token;          // ERC20 token (address(0) for ETH)
        uint256 amount;
        uint256 deadline;
        bytes32 criteriaHash;   // IPFS hash of success criteria
        EscrowState state;
        Outcome outcome;
        uint8 completionPct;    // 0-100, used for partial resolution
        uint256 createdAt;
        uint256 submittedAt;
        bytes32 evidenceHash;   // IPFS hash of submitted evidence
    }

    // =============================================================
    //                         STORAGE
    // =============================================================

    mapping(bytes32 => Escrow) public escrows;
    
    address public arbitrator;
    address public pendingArbitrator;
    
    uint256 public protocolFeeBps = 100; // 1%
    uint256 public disputeFeeBps = 100;  // 1% of escrow
    
    uint256 public clientReviewPeriod = 4 hours;
    uint256 public arbitrationTimeout = 8 hours;
    
    uint256 public minEscrowAmount = 10e6;  // $10 in USDC (6 decimals)
    uint256 public maxEscrowAmount = 5000e6; // $5000 in USDC

    uint256 public escrowCount;

    // =============================================================
    //                          EVENTS
    // =============================================================

    event EscrowCreated(
        bytes32 indexed escrowId,
        address indexed client,
        address token,
        uint256 amount,
        bytes32 criteriaHash
    );

    event EscrowAccepted(bytes32 indexed escrowId, address indexed worker);
    
    event WorkSubmitted(bytes32 indexed escrowId, bytes32 evidenceHash);
    
    event EscrowReleased(bytes32 indexed escrowId, uint256 workerAmount, uint256 protocolFee);
    
    event EscrowDisputed(bytes32 indexed escrowId, uint256 disputeFee);
    
    event EscrowResolved(
        bytes32 indexed escrowId,
        Outcome outcome,
        uint8 completionPct,
        uint256 workerAmount,
        uint256 clientRefund
    );

    event ArbitratorTransferInitiated(address indexed newArbitrator);
    event ArbitratorTransferCompleted(address indexed newArbitrator);

    // =============================================================
    //                          ERRORS
    // =============================================================

    error OnlyArbitrator();
    error OnlyClient();
    error OnlyWorker();
    error InvalidState();
    error InvalidAmount();
    error DeadlinePassed();
    error ReviewPeriodActive();
    error TransferFailed();

    // =============================================================
    //                        MODIFIERS
    // =============================================================

    modifier onlyArbitrator() {
        if (msg.sender != arbitrator) revert OnlyArbitrator();
        _;
    }

    modifier onlyClient(bytes32 escrowId) {
        if (msg.sender != escrows[escrowId].client) revert OnlyClient();
        _;
    }

    modifier onlyWorker(bytes32 escrowId) {
        if (msg.sender != escrows[escrowId].worker) revert OnlyWorker();
        _;
    }

    modifier inState(bytes32 escrowId, EscrowState expected) {
        if (escrows[escrowId].state != expected) revert InvalidState();
        _;
    }

    // =============================================================
    //                       CONSTRUCTOR
    // =============================================================

    constructor(address _arbitrator) {
        arbitrator = _arbitrator;
    }

    // =============================================================
    //                     ESCROW LIFECYCLE
    // =============================================================

    /**
     * @notice Create a new escrow
     * @param token ERC20 token address (use address(0) for ETH)
     * @param amount Amount to escrow
     * @param deadline Unix timestamp for work completion
     * @param criteriaHash IPFS hash of success criteria JSON
     */
    function createEscrow(
        address token,
        uint256 amount,
        uint256 deadline,
        bytes32 criteriaHash
    ) external payable returns (bytes32 escrowId) {
        if (amount < minEscrowAmount || amount > maxEscrowAmount) revert InvalidAmount();
        if (deadline <= block.timestamp) revert DeadlinePassed();

        escrowId = keccak256(abi.encodePacked(msg.sender, escrowCount++, block.timestamp));

        // Transfer funds
        if (token == address(0)) {
            if (msg.value != amount) revert InvalidAmount();
        } else {
            IERC20(token).transferFrom(msg.sender, address(this), amount);
        }

        escrows[escrowId] = Escrow({
            client: msg.sender,
            worker: address(0),
            token: token,
            amount: amount,
            deadline: deadline,
            criteriaHash: criteriaHash,
            state: EscrowState.Pending,
            outcome: Outcome.None,
            completionPct: 0,
            createdAt: block.timestamp,
            submittedAt: 0,
            evidenceHash: bytes32(0)
        });

        emit EscrowCreated(escrowId, msg.sender, token, amount, criteriaHash);
    }

    /**
     * @notice Worker accepts an escrow task
     */
    function acceptEscrow(bytes32 escrowId) external inState(escrowId, EscrowState.Pending) {
        Escrow storage e = escrows[escrowId];
        if (block.timestamp >= e.deadline) revert DeadlinePassed();
        
        e.worker = msg.sender;
        e.state = EscrowState.Active;

        emit EscrowAccepted(escrowId, msg.sender);
    }

    /**
     * @notice Worker submits completed work
     * @param evidenceHash IPFS hash of evidence/deliverables
     */
    function submitWork(
        bytes32 escrowId,
        bytes32 evidenceHash
    ) external onlyWorker(escrowId) inState(escrowId, EscrowState.Active) {
        Escrow storage e = escrows[escrowId];
        
        e.evidenceHash = evidenceHash;
        e.submittedAt = block.timestamp;
        e.state = EscrowState.Submitted;

        emit WorkSubmitted(escrowId, evidenceHash);
    }

    /**
     * @notice Client releases funds to worker (accepts delivery)
     */
    function release(bytes32 escrowId) external onlyClient(escrowId) inState(escrowId, EscrowState.Submitted) {
        Escrow storage e = escrows[escrowId];
        
        uint256 protocolFee = (e.amount * protocolFeeBps) / 10000;
        uint256 workerAmount = e.amount - protocolFee;

        e.state = EscrowState.Resolved;
        e.outcome = Outcome.FullRelease;
        e.completionPct = 100;

        _transfer(e.token, e.worker, workerAmount);
        _transfer(e.token, arbitrator, protocolFee); // Protocol fee to arbitrator (treasury)

        emit EscrowReleased(escrowId, workerAmount, protocolFee);
    }

    /**
     * @notice Client disputes the submission
     */
    function dispute(bytes32 escrowId) external payable onlyClient(escrowId) inState(escrowId, EscrowState.Submitted) {
        Escrow storage e = escrows[escrowId];
        
        // Require dispute fee (1% of escrow amount)
        uint256 disputeFee = (e.amount * disputeFeeBps) / 10000;
        if (e.token == address(0)) {
            if (msg.value != disputeFee) revert InvalidAmount();
        } else {
            IERC20(e.token).transferFrom(msg.sender, address(this), disputeFee);
        }

        e.state = EscrowState.Disputed;

        emit EscrowDisputed(escrowId, disputeFee);
    }

    /**
     * @notice Auto-release if client doesn't respond within review period
     */
    function autoRelease(bytes32 escrowId) external inState(escrowId, EscrowState.Submitted) {
        Escrow storage e = escrows[escrowId];
        
        if (block.timestamp < e.submittedAt + clientReviewPeriod) revert ReviewPeriodActive();

        uint256 protocolFee = (e.amount * protocolFeeBps) / 10000;
        uint256 workerAmount = e.amount - protocolFee;

        e.state = EscrowState.Resolved;
        e.outcome = Outcome.FullRelease;
        e.completionPct = 100;

        _transfer(e.token, e.worker, workerAmount);
        _transfer(e.token, arbitrator, protocolFee);

        emit EscrowReleased(escrowId, workerAmount, protocolFee);
    }

    // =============================================================
    //                       ARBITRATION
    // =============================================================

    /**
     * @notice Arbitrator resolves a disputed escrow
     * @param completionPct 0-100 representing work completion
     */
    function resolve(
        bytes32 escrowId,
        uint8 completionPct
    ) external onlyArbitrator inState(escrowId, EscrowState.Disputed) {
        if (completionPct > 100) revert InvalidAmount();
        
        Escrow storage e = escrows[escrowId];

        uint256 protocolFee = (e.amount * protocolFeeBps) / 10000;
        uint256 distributable = e.amount - protocolFee;
        
        uint256 workerAmount = (distributable * completionPct) / 100;
        uint256 clientRefund = distributable - workerAmount;

        Outcome outcome;
        if (completionPct == 100) {
            outcome = Outcome.FullRelease;
        } else if (completionPct == 0) {
            outcome = Outcome.FullRefund;
        } else {
            outcome = Outcome.Partial;
        }

        e.state = EscrowState.Resolved;
        e.outcome = outcome;
        e.completionPct = completionPct;

        // Return dispute fee to winner (client if <50% completion, worker if >=50%)
        uint256 disputeFee = (e.amount * disputeFeeBps) / 10000;
        
        if (workerAmount > 0) {
            _transfer(e.token, e.worker, workerAmount);
        }
        if (clientRefund > 0) {
            _transfer(e.token, e.client, clientRefund);
        }
        
        // Dispute fee to winner
        if (completionPct >= 50) {
            _transfer(e.token, e.worker, disputeFee);
        } else {
            _transfer(e.token, e.client, disputeFee);
        }
        
        _transfer(e.token, arbitrator, protocolFee);

        emit EscrowResolved(escrowId, outcome, completionPct, workerAmount, clientRefund);
    }

    // =============================================================
    //                          ADMIN
    // =============================================================

    function initiateArbitratorTransfer(address newArbitrator) external onlyArbitrator {
        pendingArbitrator = newArbitrator;
        emit ArbitratorTransferInitiated(newArbitrator);
    }

    function acceptArbitratorTransfer() external {
        if (msg.sender != pendingArbitrator) revert OnlyArbitrator();
        arbitrator = pendingArbitrator;
        pendingArbitrator = address(0);
        emit ArbitratorTransferCompleted(msg.sender);
    }

    function setFees(uint256 _protocolFeeBps, uint256 _disputeFeeBps) external onlyArbitrator {
        protocolFeeBps = _protocolFeeBps;
        disputeFeeBps = _disputeFeeBps;
    }

    function setLimits(uint256 _min, uint256 _max) external onlyArbitrator {
        minEscrowAmount = _min;
        maxEscrowAmount = _max;
    }

    function setTimeouts(uint256 _reviewPeriod, uint256 _arbitrationTimeout) external onlyArbitrator {
        clientReviewPeriod = _reviewPeriod;
        arbitrationTimeout = _arbitrationTimeout;
    }

    // =============================================================
    //                         INTERNAL
    // =============================================================

    function _transfer(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        
        if (token == address(0)) {
            (bool success,) = to.call{value: amount}("");
            if (!success) revert TransferFailed();
        } else {
            IERC20(token).transfer(to, amount);
        }
    }

    // =============================================================
    //                          VIEWS
    // =============================================================

    function getEscrow(bytes32 escrowId) external view returns (Escrow memory) {
        return escrows[escrowId];
    }
}
