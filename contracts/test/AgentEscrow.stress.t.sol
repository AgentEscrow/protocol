// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {AgentEscrow} from "../src/AgentEscrow.sol";

// Mock ERC20 for testing
contract MockERC20 {
    string public name = "Mock USDC";
    string public symbol = "USDC";
    uint8 public decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

// Malicious token that returns false on transfer
contract MaliciousToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    bool public shouldFail;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function setShouldFail(bool _shouldFail) external {
        shouldFail = _shouldFail;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (shouldFail) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (shouldFail) return false;
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

// Reentrancy attacker contract
contract ReentrancyAttacker {
    AgentEscrow public escrow;
    bytes32 public targetEscrowId;
    uint256 public attackCount;
    bool public attacking;

    constructor(address _escrow) {
        escrow = AgentEscrow(_escrow);
    }

    function setTarget(bytes32 _escrowId) external {
        targetEscrowId = _escrowId;
    }

    function attack() external {
        attacking = true;
        escrow.autoRelease(targetEscrowId);
    }

    receive() external payable {
        if (attacking && attackCount < 3) {
            attackCount++;
            // Try to re-enter
            try escrow.autoRelease(targetEscrowId) {} catch {}
        }
    }
}

contract AgentEscrowStressTest is Test {
    AgentEscrow public escrow;
    MockERC20 public usdc;
    MaliciousToken public malToken;

    address public arbitrator = address(0xA);
    address public client = address(0xB);
    address public worker = address(0xC);
    address public attacker = address(0xD);

    bytes32 public criteriaHash = keccak256("test criteria");
    bytes32 public evidenceHash = keccak256("test evidence");

    function setUp() public {
        escrow = new AgentEscrow(arbitrator);
        usdc = new MockERC20();
        malToken = new MaliciousToken();

        // Fund accounts
        usdc.mint(client, 100_000e6);
        usdc.mint(attacker, 100_000e6);
        malToken.mint(client, 100_000e6);
        vm.deal(client, 100 ether);
        vm.deal(attacker, 100 ether);

        vm.prank(client);
        usdc.approve(address(escrow), type(uint256).max);

        vm.prank(attacker);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // ============================================================
    //                    REENTRANCY TESTS
    // ============================================================

    function test_ReentrancyProtection_AutoRelease() public {
        // Setup: Create escrow with ETH where worker is the attacker contract
        ReentrancyAttacker attackerContract = new ReentrancyAttacker(address(escrow));

        // Set limits to allow ETH escrows
        vm.prank(arbitrator);
        escrow.setLimits(0.01 ether, 10 ether);

        // Create escrow
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow{value: 1 ether}(
            address(0), // ETH
            1 ether,
            block.timestamp + 1 days,
            criteriaHash,
            0
        );

        // Attacker contract accepts
        vm.prank(address(attackerContract));
        escrow.acceptEscrow(escrowId);

        // Submit work
        vm.prank(address(attackerContract));
        escrow.submitWork(escrowId, evidenceHash);

        // Fast forward past review period
        vm.warp(block.timestamp + 5 hours);

        // Set target for reentrancy attack
        attackerContract.setTarget(escrowId);

        // Attack should not succeed in re-entering
        attackerContract.attack();

        // Verify escrow is resolved (only once)
        AgentEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint8(e.state), uint8(AgentEscrow.EscrowState.Resolved));

        // Attack count should be low (reentrancy blocked)
        assertLe(attackerContract.attackCount(), 1);
    }

    // ============================================================
    //                    STATE MACHINE TESTS
    // ============================================================

    function test_CannotAcceptTwice() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc), 100e6, block.timestamp + 1 days, criteriaHash, 0
        );

        vm.prank(worker);
        escrow.acceptEscrow(escrowId);

        // Second accept should fail
        vm.prank(address(0xE));
        vm.expectRevert(AgentEscrow.InvalidState.selector);
        escrow.acceptEscrow(escrowId);
    }

    function test_CannotSubmitWithoutAccepting() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc), 100e6, block.timestamp + 1 days, criteriaHash, 0
        );

        // Worker is address(0) before acceptance, so OnlyWorker error fires first
        vm.prank(worker);
        vm.expectRevert(AgentEscrow.OnlyWorker.selector);
        escrow.submitWork(escrowId, evidenceHash);
    }

    function test_CannotReleaseWithoutSubmission() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc), 100e6, block.timestamp + 1 days, criteriaHash, 0
        );

        vm.prank(worker);
        escrow.acceptEscrow(escrowId);

        vm.prank(client);
        vm.expectRevert(AgentEscrow.InvalidState.selector);
        escrow.release(escrowId);
    }

    function test_CannotDisputeWithoutSubmission() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc), 100e6, block.timestamp + 1 days, criteriaHash, 0
        );

        vm.prank(worker);
        escrow.acceptEscrow(escrowId);

        vm.prank(client);
        vm.expectRevert(AgentEscrow.InvalidState.selector);
        escrow.dispute(escrowId);
    }

    function test_CannotResolveWithoutDispute() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc), 100e6, block.timestamp + 1 days, criteriaHash, 0
        );

        vm.prank(worker);
        escrow.acceptEscrow(escrowId);

        vm.prank(worker);
        escrow.submitWork(escrowId, evidenceHash);

        vm.prank(arbitrator);
        vm.expectRevert(AgentEscrow.InvalidState.selector);
        escrow.resolve(escrowId, 50);
    }

    function test_CannotDoubleRelease() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc), 100e6, block.timestamp + 1 days, criteriaHash, 0
        );

        vm.prank(worker);
        escrow.acceptEscrow(escrowId);

        vm.prank(worker);
        escrow.submitWork(escrowId, evidenceHash);

        vm.prank(client);
        escrow.release(escrowId);

        // Second release should fail
        vm.prank(client);
        vm.expectRevert(AgentEscrow.InvalidState.selector);
        escrow.release(escrowId);
    }

    // ============================================================
    //                    EDGE CASE TESTS
    // ============================================================

    function test_MinimumEscrowAmount() public {
        // Just above minimum should work
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc), 10e6, block.timestamp + 1 days, criteriaHash, 0
        );
        assertNotEq(escrowId, bytes32(0));
    }

    function test_MaximumEscrowAmount() public {
        // At maximum should work
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc), 5000e6, block.timestamp + 1 days, criteriaHash, 0
        );
        assertNotEq(escrowId, bytes32(0));
    }

    function test_BelowMinimumReverts() public {
        vm.prank(client);
        vm.expectRevert(AgentEscrow.InvalidAmount.selector);
        escrow.createEscrow(address(usdc), 9e6, block.timestamp + 1 days, criteriaHash, 0);
    }

    function test_AboveMaximumReverts() public {
        vm.prank(client);
        vm.expectRevert(AgentEscrow.InvalidAmount.selector);
        escrow.createEscrow(address(usdc), 5001e6, block.timestamp + 1 days, criteriaHash, 0);
    }

    function test_DeadlineInPastReverts() public {
        vm.prank(client);
        vm.expectRevert(AgentEscrow.DeadlinePassed.selector);
        escrow.createEscrow(address(usdc), 100e6, block.timestamp - 1, criteriaHash, 0);
    }

    function test_AcceptAfterDeadlineReverts() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc), 100e6, block.timestamp + 1 hours, criteriaHash, 0
        );

        // Fast forward past deadline
        vm.warp(block.timestamp + 2 hours);

        vm.prank(worker);
        vm.expectRevert(AgentEscrow.DeadlinePassed.selector);
        escrow.acceptEscrow(escrowId);
    }

    // ============================================================
    //                    FEE CALCULATION TESTS
    // ============================================================

    function test_ProtocolFeeCalculation() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc), 1000e6, block.timestamp + 1 days, criteriaHash, 0
        );

        vm.prank(worker);
        escrow.acceptEscrow(escrowId);

        vm.prank(worker);
        escrow.submitWork(escrowId, evidenceHash);

        uint256 workerBalanceBefore = usdc.balanceOf(worker);
        uint256 arbitratorBalanceBefore = usdc.balanceOf(arbitrator);

        vm.prank(client);
        escrow.release(escrowId);

        // 1% protocol fee = 10 USDC, worker gets 990 USDC
        assertEq(usdc.balanceOf(worker) - workerBalanceBefore, 990e6);
        assertEq(usdc.balanceOf(arbitrator) - arbitratorBalanceBefore, 10e6);
    }

    function test_DisputeFeeCalculation() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc), 1000e6, block.timestamp + 1 days, criteriaHash, 0
        );

        vm.prank(worker);
        escrow.acceptEscrow(escrowId);

        vm.prank(worker);
        escrow.submitWork(escrowId, evidenceHash);

        // Need extra for dispute fee
        usdc.mint(client, 10e6);
        vm.prank(client);
        usdc.approve(address(escrow), 10e6);

        uint256 clientBalanceBefore = usdc.balanceOf(client);

        vm.prank(client);
        escrow.dispute(escrowId);

        // 1% dispute fee = 10 USDC
        assertEq(clientBalanceBefore - usdc.balanceOf(client), 10e6);
    }

    function test_PartialResolution_50Percent() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc), 1000e6, block.timestamp + 1 days, criteriaHash, 0
        );

        vm.prank(worker);
        escrow.acceptEscrow(escrowId);

        vm.prank(worker);
        escrow.submitWork(escrowId, evidenceHash);

        usdc.mint(client, 10e6);
        vm.prank(client);
        usdc.approve(address(escrow), 10e6);

        vm.prank(client);
        escrow.dispute(escrowId);

        uint256 workerBalanceBefore = usdc.balanceOf(worker);
        uint256 clientBalanceBefore = usdc.balanceOf(client);

        vm.prank(arbitrator);
        escrow.resolve(escrowId, 50);

        // Distributable = 1000 - 10 (protocol fee) = 990
        // Worker gets 50% = 495 + dispute fee (10) = 505
        // Client gets 50% = 495
        assertEq(usdc.balanceOf(worker) - workerBalanceBefore, 505e6);
        assertEq(usdc.balanceOf(client) - clientBalanceBefore, 495e6);
    }

    function test_PartialResolution_0Percent() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc), 1000e6, block.timestamp + 1 days, criteriaHash, 0
        );

        vm.prank(worker);
        escrow.acceptEscrow(escrowId);

        vm.prank(worker);
        escrow.submitWork(escrowId, evidenceHash);

        usdc.mint(client, 10e6);
        vm.prank(client);
        usdc.approve(address(escrow), 10e6);

        vm.prank(client);
        escrow.dispute(escrowId);

        uint256 workerBalanceBefore = usdc.balanceOf(worker);
        uint256 clientBalanceBefore = usdc.balanceOf(client);

        vm.prank(arbitrator);
        escrow.resolve(escrowId, 0);

        // Worker gets 0
        // Client gets 990 + dispute fee (10) = 1000
        assertEq(usdc.balanceOf(worker) - workerBalanceBefore, 0);
        assertEq(usdc.balanceOf(client) - clientBalanceBefore, 1000e6);
    }

    function test_PartialResolution_100Percent() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc), 1000e6, block.timestamp + 1 days, criteriaHash, 0
        );

        vm.prank(worker);
        escrow.acceptEscrow(escrowId);

        vm.prank(worker);
        escrow.submitWork(escrowId, evidenceHash);

        usdc.mint(client, 10e6);
        vm.prank(client);
        usdc.approve(address(escrow), 10e6);

        vm.prank(client);
        escrow.dispute(escrowId);

        uint256 workerBalanceBefore = usdc.balanceOf(worker);
        uint256 clientBalanceBefore = usdc.balanceOf(client);

        vm.prank(arbitrator);
        escrow.resolve(escrowId, 100);

        // Worker gets 990 + dispute fee (10) = 1000
        // Client gets 0
        assertEq(usdc.balanceOf(worker) - workerBalanceBefore, 1000e6);
        assertEq(usdc.balanceOf(client) - clientBalanceBefore, 0);
    }

    // ============================================================
    //                    MALICIOUS TOKEN TESTS
    // ============================================================

    function test_MaliciousTokenTransferFailure() public {
        vm.prank(client);
        malToken.approve(address(escrow), type(uint256).max);

        // Create escrow (this should work)
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(malToken), 100e6, block.timestamp + 1 days, criteriaHash, 0
        );

        vm.prank(worker);
        escrow.acceptEscrow(escrowId);

        vm.prank(worker);
        escrow.submitWork(escrowId, evidenceHash);

        // Now make token fail transfers
        malToken.setShouldFail(true);

        // Release should revert
        vm.prank(client);
        vm.expectRevert(AgentEscrow.TransferFailed.selector);
        escrow.release(escrowId);
    }

    // ============================================================
    //                    ETH ESCROW TESTS
    // ============================================================

    function test_ETHEscrowFullFlow() public {
        // Set limits to allow ETH
        vm.prank(arbitrator);
        escrow.setLimits(0.01 ether, 10 ether);

        uint256 clientBalanceBefore = client.balance;
        uint256 workerBalanceBefore = worker.balance;

        // Create with ETH
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow{value: 1 ether}(
            address(0), 1 ether, block.timestamp + 1 days, criteriaHash, 0
        );

        assertEq(client.balance, clientBalanceBefore - 1 ether);

        vm.prank(worker);
        escrow.acceptEscrow(escrowId);

        vm.prank(worker);
        escrow.submitWork(escrowId, evidenceHash);

        vm.prank(client);
        escrow.release(escrowId);

        // Worker gets 99% (0.99 ETH)
        assertEq(worker.balance - workerBalanceBefore, 0.99 ether);
    }

    function test_ETHEscrow_WrongValueReverts() public {
        vm.prank(arbitrator);
        escrow.setLimits(0.01 ether, 10 ether);

        // Send wrong amount
        vm.prank(client);
        vm.expectRevert(AgentEscrow.InvalidAmount.selector);
        escrow.createEscrow{value: 0.5 ether}(
            address(0), 1 ether, block.timestamp + 1 days, criteriaHash, 0
        );
    }

    // ============================================================
    //                    AUTHORIZATION TESTS
    // ============================================================

    function test_OnlyClientCanRelease() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc), 100e6, block.timestamp + 1 days, criteriaHash, 0
        );

        vm.prank(worker);
        escrow.acceptEscrow(escrowId);

        vm.prank(worker);
        escrow.submitWork(escrowId, evidenceHash);

        // Worker tries to release
        vm.prank(worker);
        vm.expectRevert(AgentEscrow.OnlyClient.selector);
        escrow.release(escrowId);

        // Random address tries
        vm.prank(attacker);
        vm.expectRevert(AgentEscrow.OnlyClient.selector);
        escrow.release(escrowId);
    }

    function test_OnlyWorkerCanSubmit() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc), 100e6, block.timestamp + 1 days, criteriaHash, 0
        );

        vm.prank(worker);
        escrow.acceptEscrow(escrowId);

        // Client tries to submit
        vm.prank(client);
        vm.expectRevert(AgentEscrow.OnlyWorker.selector);
        escrow.submitWork(escrowId, evidenceHash);
    }

    function test_OnlyArbitratorCanResolve() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc), 100e6, block.timestamp + 1 days, criteriaHash, 0
        );

        vm.prank(worker);
        escrow.acceptEscrow(escrowId);

        vm.prank(worker);
        escrow.submitWork(escrowId, evidenceHash);

        usdc.mint(client, 1e6);
        vm.prank(client);
        usdc.approve(address(escrow), 1e6);

        vm.prank(client);
        escrow.dispute(escrowId);

        // Client tries to resolve
        vm.prank(client);
        vm.expectRevert(AgentEscrow.OnlyArbitrator.selector);
        escrow.resolve(escrowId, 50);

        // Worker tries to resolve
        vm.prank(worker);
        vm.expectRevert(AgentEscrow.OnlyArbitrator.selector);
        escrow.resolve(escrowId, 50);
    }

    // ============================================================
    //                    FUZZ TESTS
    // ============================================================

    function testFuzz_CreateEscrowAmount(uint256 amount) public {
        // Bound to valid range
        amount = bound(amount, 10e6, 5000e6);

        usdc.mint(client, amount);
        vm.prank(client);
        usdc.approve(address(escrow), amount);

        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc), amount, block.timestamp + 1 days, criteriaHash, 0
        );

        AgentEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(e.amount, amount);
    }

    function testFuzz_ResolveCompletionPct(uint8 completionPct) public {
        // Bound to valid range
        completionPct = uint8(bound(completionPct, 0, 100));

        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc), 1000e6, block.timestamp + 1 days, criteriaHash, 0
        );

        vm.prank(worker);
        escrow.acceptEscrow(escrowId);

        vm.prank(worker);
        escrow.submitWork(escrowId, evidenceHash);

        usdc.mint(client, 10e6);
        vm.prank(client);
        usdc.approve(address(escrow), 10e6);

        vm.prank(client);
        escrow.dispute(escrowId);

        uint256 workerBalanceBefore = usdc.balanceOf(worker);
        uint256 clientBalanceBefore = usdc.balanceOf(client);
        uint256 arbitratorBalanceBefore = usdc.balanceOf(arbitrator);

        vm.prank(arbitrator);
        escrow.resolve(escrowId, completionPct);

        AgentEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(e.completionPct, completionPct);
        assertEq(uint8(e.state), uint8(AgentEscrow.EscrowState.Resolved));

        // Verify all funds distributed (escrow balance should be 0)
        uint256 totalDistributed =
            (usdc.balanceOf(worker) - workerBalanceBefore) +
            (usdc.balanceOf(client) - clientBalanceBefore) +
            (usdc.balanceOf(arbitrator) - arbitratorBalanceBefore);

        // Total should be escrow amount + dispute fee
        assertEq(totalDistributed, 1010e6);
    }

    function testFuzz_InvalidCompletionPctReverts(uint8 completionPct) public {
        vm.assume(completionPct > 100);

        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc), 100e6, block.timestamp + 1 days, criteriaHash, 0
        );

        vm.prank(worker);
        escrow.acceptEscrow(escrowId);

        vm.prank(worker);
        escrow.submitWork(escrowId, evidenceHash);

        usdc.mint(client, 1e6);
        vm.prank(client);
        usdc.approve(address(escrow), 1e6);

        vm.prank(client);
        escrow.dispute(escrowId);

        vm.prank(arbitrator);
        vm.expectRevert(AgentEscrow.InvalidAmount.selector);
        escrow.resolve(escrowId, completionPct);
    }

    // ============================================================
    //                    MULTI-ESCROW TESTS
    // ============================================================

    function test_MultipleEscrowsIsolated() public {
        // Create 10 escrows
        bytes32[] memory escrowIds = new bytes32[](10);

        for (uint256 i = 0; i < 10; i++) {
            usdc.mint(client, 100e6);
            vm.prank(client);
            usdc.approve(address(escrow), 100e6);

            vm.prank(client);
            escrowIds[i] = escrow.createEscrow(
                address(usdc), 100e6, block.timestamp + 1 days, criteriaHash, 0
            );
        }

        // Verify all are unique and isolated
        for (uint256 i = 0; i < 10; i++) {
            AgentEscrow.Escrow memory e = escrow.getEscrow(escrowIds[i]);
            assertEq(e.amount, 100e6);
            assertEq(uint8(e.state), uint8(AgentEscrow.EscrowState.Pending));

            // Each ID should be unique
            for (uint256 j = i + 1; j < 10; j++) {
                assertNotEq(escrowIds[i], escrowIds[j]);
            }
        }
    }

    // ============================================================
    //                    ADMIN FUNCTION TESTS
    // ============================================================

    function test_ArbitratorTransfer() public {
        address newArbitrator = address(0xF);

        vm.prank(arbitrator);
        escrow.initiateArbitratorTransfer(newArbitrator);

        assertEq(escrow.pendingArbitrator(), newArbitrator);

        vm.prank(newArbitrator);
        escrow.acceptArbitratorTransfer();

        assertEq(escrow.arbitrator(), newArbitrator);
        assertEq(escrow.pendingArbitrator(), address(0));
    }

    function test_OnlyArbitratorCanInitiateTransfer() public {
        vm.prank(client);
        vm.expectRevert(AgentEscrow.OnlyArbitrator.selector);
        escrow.initiateArbitratorTransfer(address(0xF));
    }

    function test_OnlyPendingCanAcceptTransfer() public {
        vm.prank(arbitrator);
        escrow.initiateArbitratorTransfer(address(0xF));

        vm.prank(client);
        vm.expectRevert(AgentEscrow.OnlyArbitrator.selector);
        escrow.acceptArbitratorTransfer();
    }

    function test_SetFees() public {
        vm.prank(arbitrator);
        escrow.setFees(200, 50); // 2% protocol, 0.5% dispute

        assertEq(escrow.protocolFeeBps(), 200);
        assertEq(escrow.disputeFeeBps(), 50);
    }

    function test_SetLimits() public {
        vm.prank(arbitrator);
        escrow.setLimits(1e6, 10000e6);

        assertEq(escrow.minEscrowAmount(), 1e6);
        assertEq(escrow.maxEscrowAmount(), 10000e6);
    }
}
