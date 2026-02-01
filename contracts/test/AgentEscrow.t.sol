// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {AgentEscrow} from "../src/AgentEscrow.sol";

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

contract AgentEscrowTest is Test {
    AgentEscrow public escrow;
    MockERC20 public usdc;
    
    address public arbitrator = address(0xA);
    address public client = address(0xB);
    address public worker = address(0xC);
    
    bytes32 public criteriaHash = keccak256("test criteria");
    bytes32 public evidenceHash = keccak256("test evidence");
    
    function setUp() public {
        escrow = new AgentEscrow(arbitrator);
        usdc = new MockERC20();
        
        // Fund client
        usdc.mint(client, 10000e6);
        
        vm.prank(client);
        usdc.approve(address(escrow), type(uint256).max);
    }
    
    function test_CreateEscrow() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc),
            100e6, // $100
            block.timestamp + 1 days,
            criteriaHash,
            0 // Use default review period
        );
        
        AgentEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(e.client, client);
        assertEq(e.amount, 100e6);
        assertEq(uint8(e.state), uint8(AgentEscrow.EscrowState.Pending));
    }
    
    function test_AcceptEscrow() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc),
            100e6,
            block.timestamp + 1 days,
            criteriaHash,
            0 // Use default review period
        );
        
        vm.prank(worker);
        escrow.acceptEscrow(escrowId);
        
        AgentEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(e.worker, worker);
        assertEq(uint8(e.state), uint8(AgentEscrow.EscrowState.Active));
    }
    
    function test_SubmitWork() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc),
            100e6,
            block.timestamp + 1 days,
            criteriaHash,
            0 // Use default review period
        );
        
        vm.prank(worker);
        escrow.acceptEscrow(escrowId);
        
        vm.prank(worker);
        escrow.submitWork(escrowId, evidenceHash);
        
        AgentEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(e.evidenceHash, evidenceHash);
        assertEq(uint8(e.state), uint8(AgentEscrow.EscrowState.Submitted));
    }
    
    function test_Release() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc),
            100e6,
            block.timestamp + 1 days,
            criteriaHash,
            0 // Use default review period
        );
        
        vm.prank(worker);
        escrow.acceptEscrow(escrowId);
        
        vm.prank(worker);
        escrow.submitWork(escrowId, evidenceHash);
        
        uint256 workerBalanceBefore = usdc.balanceOf(worker);
        
        vm.prank(client);
        escrow.release(escrowId);
        
        AgentEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint8(e.state), uint8(AgentEscrow.EscrowState.Resolved));
        assertEq(uint8(e.outcome), uint8(AgentEscrow.Outcome.FullRelease));
        
        // Worker should receive 99% (100% - 1% protocol fee)
        assertEq(usdc.balanceOf(worker) - workerBalanceBefore, 99e6);
    }
    
    function test_Dispute_And_Resolve() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc),
            100e6,
            block.timestamp + 1 days,
            criteriaHash,
            0 // Use default review period
        );
        
        vm.prank(worker);
        escrow.acceptEscrow(escrowId);
        
        vm.prank(worker);
        escrow.submitWork(escrowId, evidenceHash);
        
        // Client disputes (needs to pay dispute fee)
        usdc.mint(client, 1e6); // 1% dispute fee
        vm.prank(client);
        usdc.approve(address(escrow), 1e6);
        
        vm.prank(client);
        escrow.dispute(escrowId);
        
        AgentEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint8(e.state), uint8(AgentEscrow.EscrowState.Disputed));
        
        // Arbitrator resolves with 70% completion
        uint256 workerBalanceBefore = usdc.balanceOf(worker);
        uint256 clientBalanceBefore = usdc.balanceOf(client);
        
        vm.prank(arbitrator);
        escrow.resolve(escrowId, 70);
        
        e = escrow.getEscrow(escrowId);
        assertEq(uint8(e.state), uint8(AgentEscrow.EscrowState.Resolved));
        assertEq(uint8(e.outcome), uint8(AgentEscrow.Outcome.Partial));
        assertEq(e.completionPct, 70);
        
        // Worker gets 70% of 99 (after protocol fee) + dispute fee (since >=50%)
        // = 69.3 + 1 = 70.3
        uint256 workerReceived = usdc.balanceOf(worker) - workerBalanceBefore;
        assertGt(workerReceived, 69e6);
        
        // Client gets 30% of 99 = 29.7
        uint256 clientReceived = usdc.balanceOf(client) - clientBalanceBefore;
        assertGt(clientReceived, 29e6);
    }
    
    function test_AutoRelease() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc),
            100e6,
            block.timestamp + 1 days,
            criteriaHash,
            0 // Use default review period
        );
        
        vm.prank(worker);
        escrow.acceptEscrow(escrowId);
        
        vm.prank(worker);
        escrow.submitWork(escrowId, evidenceHash);
        
        // Fast forward past review period (4 hours)
        vm.warp(block.timestamp + 5 hours);
        
        uint256 workerBalanceBefore = usdc.balanceOf(worker);
        
        // Anyone can call autoRelease
        escrow.autoRelease(escrowId);
        
        AgentEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint8(e.state), uint8(AgentEscrow.EscrowState.Resolved));
        assertEq(usdc.balanceOf(worker) - workerBalanceBefore, 99e6);
    }
    
    function test_RevertWhen_NotClient() public {
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc),
            100e6,
            block.timestamp + 1 days,
            criteriaHash,
            0 // Use default review period
        );
        
        vm.prank(worker);
        escrow.acceptEscrow(escrowId);
        
        vm.prank(worker);
        escrow.submitWork(escrowId, evidenceHash);
        
        // Worker tries to release (should fail)
        vm.prank(worker);
        vm.expectRevert(AgentEscrow.OnlyClient.selector);
        escrow.release(escrowId);
    }
    
    function test_RevertWhen_AmountTooLow() public {
        vm.prank(client);
        vm.expectRevert(AgentEscrow.InvalidAmount.selector);
        escrow.createEscrow(
            address(usdc),
            1e6, // $1 - below minimum
            block.timestamp + 1 days,
            criteriaHash,
            0
        );
    }

    function test_CustomReviewPeriod() public {
        // Create escrow with 1 hour custom review period
        vm.prank(client);
        bytes32 escrowId = escrow.createEscrow(
            address(usdc),
            100e6,
            block.timestamp + 1 days,
            criteriaHash,
            1 hours // Custom 1 hour review period
        );

        vm.prank(worker);
        escrow.acceptEscrow(escrowId);

        vm.prank(worker);
        escrow.submitWork(escrowId, evidenceHash);

        // Try to auto-release after 30 minutes (should fail)
        vm.warp(block.timestamp + 30 minutes);
        vm.expectRevert(AgentEscrow.ReviewPeriodActive.selector);
        escrow.autoRelease(escrowId);

        // Fast forward to 1.5 hours (past custom review period)
        vm.warp(block.timestamp + 1 hours);

        uint256 workerBalanceBefore = usdc.balanceOf(worker);
        escrow.autoRelease(escrowId);

        AgentEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint8(e.state), uint8(AgentEscrow.EscrowState.Resolved));
        assertEq(usdc.balanceOf(worker) - workerBalanceBefore, 99e6);
    }
}
