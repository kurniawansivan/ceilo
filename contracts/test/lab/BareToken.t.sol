// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BareToken} from "./BareToken.sol";

/// @notice S3 lab: an ERC-20 written from EIP-20 alone, and what the standard leaves open.
contract BareTokenTest is Test {
    // Events are redeclared so the tests can name them in expectEmit.
    /// @notice The ERC-20 transfer event.
    event Transfer(address indexed from, address indexed to, uint256 value);
    /// @notice The ERC-20 approval event.
    event Approval(address indexed owner, address indexed spender, uint256 value);

    uint256 internal constant SUPPLY = 1_000_000e18;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    BareToken internal token;

    /// @notice Deploys a token whose whole supply goes to Alice.
    function setUp() public {
        vm.prank(alice);
        token = new BareToken("Bare Token", "BARE", 18, SUPPLY);
    }

    /// @notice The state a failed call must leave untouched: both balances, the total and the allowance.
    function _snapshot(address owner, address recipient, address spender)
        internal
        view
        returns (uint256, uint256, uint256, uint256)
    {
        return
            (token.balanceOf(owner), token.balanceOf(recipient), token.totalSupply(), token.allowance(owner, spender));
    }

    // ---------------------------------------------------------------- metadata and supply

    /// @notice The metadata and the supply are what the constructor was given.
    function test_ConstructorSetsMetadataAndSupply() public view {
        assertEq(token.name(), "Bare Token");
        assertEq(token.symbol(), "BARE");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), SUPPLY);
    }

    /// @notice The deployer holds the whole supply and nobody else holds anything.
    function test_DeployerHoldsTheWholeSupply() public view {
        assertEq(token.balanceOf(alice), SUPPLY);
        assertEq(token.balanceOf(bob), 0);
    }

    /// @notice Creating the supply emits a Transfer from the zero address, as EIP-20 advises for new tokens.
    function test_ConstructorEmitsATransferFromTheZeroAddress() public {
        vm.expectEmit(true, true, false, true);
        emit Transfer(address(0), alice, SUPPLY);

        vm.prank(alice);
        new BareToken("Bare Token", "BARE", 18, SUPPLY);
    }

    /// @notice The token answers every ERC-20 call through OpenZeppelin's IERC20, so its ABI is the standard one.
    function test_TokenSpeaksTheErc20InterfaceOfOpenZeppelin() public {
        IERC20 erc20 = IERC20(address(token));

        assertEq(erc20.totalSupply(), SUPPLY);
        assertEq(erc20.balanceOf(alice), SUPPLY);
        vm.prank(alice);
        assertTrue(erc20.transfer(bob, 10));
        vm.prank(alice);
        assertTrue(erc20.approve(bob, 5));
        assertEq(erc20.allowance(alice, bob), 5);
        vm.prank(bob);
        assertTrue(erc20.transferFrom(alice, carol, 5));
        assertEq(erc20.balanceOf(carol), 5);
    }

    // ---------------------------------------------------------------- transfer

    /// @notice A transfer moves the value from the sender to the recipient and leaves the total alone.
    function test_TransferMovesTheValue() public {
        vm.prank(alice);
        bool succeeded = token.transfer(bob, 100);

        assertTrue(succeeded);
        assertEq(token.balanceOf(alice), SUPPLY - 100);
        assertEq(token.balanceOf(bob), 100);
        assertEq(token.totalSupply(), SUPPLY);
    }

    /// @notice A transfer emits Transfer with the sender, the recipient and the value.
    function test_TransferEmitsTransfer() public {
        vm.expectEmit(true, true, false, true, address(token));
        emit Transfer(alice, bob, 100);

        vm.prank(alice);
        token.transfer(bob, 100);
    }

    /// @notice A transfer of zero succeeds and still emits Transfer, because EIP-20 says it must.
    function test_ZeroValueTransferSucceedsAndEmits() public {
        vm.expectEmit(true, true, false, true, address(token));
        emit Transfer(alice, bob, 0);

        vm.prank(alice);
        assertTrue(token.transfer(bob, 0));
        assertEq(token.balanceOf(bob), 0);
    }

    /// @notice An account can send its whole balance and be left with nothing.
    function test_TransferOfTheWholeBalanceLeavesZero() public {
        vm.prank(alice);
        token.transfer(bob, SUPPLY);

        assertEq(token.balanceOf(alice), 0);
        assertEq(token.balanceOf(bob), SUPPLY);
    }

    /// @notice A transfer of more than the balance reverts with the balance and the amount needed, and changes nothing.
    function test_TransferOfMoreThanTheBalanceReverts() public {
        vm.prank(alice);
        token.transfer(bob, 100);
        (uint256 bobBefore, uint256 carolBefore, uint256 supplyBefore, uint256 allowanceBefore) =
            _snapshot(bob, carol, alice);

        vm.expectRevert(abi.encodeWithSelector(BareToken.InsufficientBalance.selector, bob, 100, 101));
        vm.prank(bob);
        token.transfer(carol, 101);

        (uint256 bobAfter, uint256 carolAfter, uint256 supplyAfter, uint256 allowanceAfter) =
            _snapshot(bob, carol, alice);
        assertEq(bobAfter, bobBefore);
        assertEq(carolAfter, carolBefore);
        assertEq(supplyAfter, supplyBefore);
        assertEq(allowanceAfter, allowanceBefore);
    }

    /// @notice An account with nothing cannot send even one unit.
    function test_TransferFromAnEmptyAccountReverts() public {
        vm.expectRevert(abi.encodeWithSelector(BareToken.InsufficientBalance.selector, bob, 0, 1));
        vm.prank(bob);
        token.transfer(carol, 1);
    }

    /// @notice Sending to oneself leaves the balance as it was and still emits Transfer.
    function test_TransferToOneselfChangesNothingAndEmits() public {
        vm.expectEmit(true, true, false, true, address(token));
        emit Transfer(alice, alice, 100);

        vm.prank(alice);
        token.transfer(alice, 100);

        assertEq(token.balanceOf(alice), SUPPLY);
    }

    /// @notice EIP-20 does not forbid sending to the zero address, so the tokens go there and are lost: a trap.
    function test_TransferToTheZeroAddressSucceedsAndTheTokensAreLost() public {
        vm.prank(alice);
        token.transfer(address(0), 100);

        assertEq(token.balanceOf(address(0)), 100);
        assertEq(token.totalSupply(), SUPPLY);
    }

    // ---------------------------------------------------------------- approve and allowance

    /// @notice Approving sets the allowance, returns true and emits Approval.
    function test_ApproveSetsTheAllowanceAndEmitsApproval() public {
        vm.expectEmit(true, true, false, true, address(token));
        emit Approval(alice, bob, 50);

        vm.prank(alice);
        bool succeeded = token.approve(bob, 50);

        assertTrue(succeeded);
        assertEq(token.allowance(alice, bob), 50);
    }

    /// @notice A second approval replaces the first; it does not add to it.
    function test_ApproveOverwritesThePreviousAllowance() public {
        vm.startPrank(alice);
        token.approve(bob, 50);
        token.approve(bob, 30);
        vm.stopPrank();

        assertEq(token.allowance(alice, bob), 30);
    }

    /// @notice An allowance is per owner and per spender, so approving one spender gives nothing to another.
    function test_AllowanceBelongsToOneOwnerAndOneSpender() public {
        vm.prank(alice);
        token.approve(bob, 50);

        assertEq(token.allowance(alice, carol), 0);
        assertEq(token.allowance(bob, alice), 0);
    }

    /// @notice An allowance may exceed the balance, because it is only checked when it is spent.
    function test_ApproveMayExceedTheBalance() public {
        vm.prank(bob);
        token.approve(carol, 1_000);

        assertEq(token.allowance(bob, carol), 1_000);
    }

    /// @notice Approving zero takes the allowance back.
    function test_ApproveZeroRemovesTheAllowance() public {
        vm.startPrank(alice);
        token.approve(bob, 50);
        token.approve(bob, 0);
        vm.stopPrank();

        assertEq(token.allowance(alice, bob), 0);
    }

    // ---------------------------------------------------------------- transferFrom

    /// @notice A spender moves the owner's tokens, the allowance shrinks by the value, and the total is unchanged.
    function test_TransferFromMovesTokensAndSpendsTheAllowance() public {
        vm.prank(alice);
        token.approve(bob, 50);

        vm.prank(bob);
        bool succeeded = token.transferFrom(alice, carol, 30);

        assertTrue(succeeded);
        assertEq(token.balanceOf(alice), SUPPLY - 30);
        assertEq(token.balanceOf(carol), 30);
        assertEq(token.balanceOf(bob), 0);
        assertEq(token.allowance(alice, bob), 20);
        assertEq(token.totalSupply(), SUPPLY);
    }

    /// @notice A transferFrom emits Transfer, and does not emit Approval for the smaller allowance.
    function test_TransferFromEmitsTransferAndNoApproval() public {
        vm.prank(alice);
        token.approve(bob, 50);

        vm.recordLogs();
        vm.prank(bob);
        token.transferFrom(alice, carol, 30);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], Transfer.selector);
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(alice))));
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(carol))));
        assertEq(abi.decode(logs[0].data, (uint256)), 30);
    }

    /// @notice A spender may use up the allowance exactly, leaving zero.
    function test_TransferFromMayUseTheWholeAllowance() public {
        vm.prank(alice);
        token.approve(bob, 50);

        vm.prank(bob);
        token.transferFrom(alice, carol, 50);

        assertEq(token.allowance(alice, bob), 0);
    }

    /// @notice A spender cannot move more than the allowance, and a failed attempt changes nothing.
    function test_TransferFromBeyondTheAllowanceReverts() public {
        vm.prank(alice);
        token.approve(bob, 50);
        (uint256 aliceBefore, uint256 carolBefore, uint256 supplyBefore, uint256 allowanceBefore) =
            _snapshot(alice, carol, bob);

        vm.expectRevert(abi.encodeWithSelector(BareToken.InsufficientAllowance.selector, bob, 50, 51));
        vm.prank(bob);
        token.transferFrom(alice, carol, 51);

        (uint256 aliceAfter, uint256 carolAfter, uint256 supplyAfter, uint256 allowanceAfter) =
            _snapshot(alice, carol, bob);
        assertEq(aliceAfter, aliceBefore);
        assertEq(carolAfter, carolBefore);
        assertEq(supplyAfter, supplyBefore);
        assertEq(allowanceAfter, allowanceBefore);
    }

    /// @notice A spender with no allowance at all cannot move anything.
    function test_TransferFromWithoutAnAllowanceReverts() public {
        vm.expectRevert(abi.encodeWithSelector(BareToken.InsufficientAllowance.selector, bob, 0, 1));
        vm.prank(bob);
        token.transferFrom(alice, carol, 1);
    }

    /// @notice An allowance larger than the owner's balance does not let the spender move more than the balance.
    function test_TransferFromBeyondTheBalanceRevertsEvenWithAnAllowance() public {
        vm.prank(bob);
        token.approve(carol, 1_000);

        vm.expectRevert(abi.encodeWithSelector(BareToken.InsufficientBalance.selector, bob, 0, 1));
        vm.prank(carol);
        token.transferFrom(bob, alice, 1);
    }

    /// @notice When both the allowance and the balance fall short, the allowance is the error reported.
    function test_AllowanceIsCheckedBeforeTheBalance() public {
        vm.expectRevert(abi.encodeWithSelector(BareToken.InsufficientAllowance.selector, carol, 0, 1));
        vm.prank(carol);
        token.transferFrom(bob, alice, 1);
    }

    /// @notice A failed transferFrom does not spend any of the allowance.
    function test_FailedTransferFromLeavesTheAllowanceIntact() public {
        vm.prank(bob);
        token.approve(carol, 1_000);

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(BareToken.InsufficientBalance.selector, bob, 0, 1));
        token.transferFrom(bob, alice, 1);

        assertEq(token.allowance(bob, carol), 1_000);
    }

    /// @notice A transferFrom of zero succeeds without any allowance and emits Transfer, like any zero transfer.
    function test_ZeroValueTransferFromNeedsNoAllowance() public {
        vm.expectEmit(true, true, false, true, address(token));
        emit Transfer(alice, carol, 0);

        vm.prank(bob);
        assertTrue(token.transferFrom(alice, carol, 0));
    }

    /// @notice An owner has no special right through transferFrom: it needs an allowance from itself.
    function test_OwnerNeedsAnAllowanceFromItselfToUseTransferFrom() public {
        vm.expectRevert(abi.encodeWithSelector(BareToken.InsufficientAllowance.selector, alice, 0, 10));
        vm.prank(alice);
        token.transferFrom(alice, bob, 10);
    }

    /// @notice A maximum allowance is spent like any other here, so it shrinks; OpenZeppelin treats it as unlimited.
    function test_MaximumAllowanceIsStillSpent() public {
        vm.prank(alice);
        token.approve(bob, type(uint256).max);

        vm.prank(bob);
        token.transferFrom(alice, carol, 100);

        assertEq(token.allowance(alice, bob), type(uint256).max - 100);
    }

    // ---------------------------------------------------------------- the approve race

    /// @notice Changing an allowance from 50 to 30 lets a spender who acts in between spend 50 and then 30: 80 in all.
    function test_ApproveRaceLetsASpenderSpendBothTheOldAndTheNewAllowance() public {
        vm.prank(alice);
        token.approve(bob, 50);

        // Alice sends approve(bob, 30). Bob sees it waiting and spends the old allowance first.
        vm.prank(bob);
        token.transferFrom(alice, bob, 50);
        // Alice's approve lands, setting the allowance to 30 although 50 were already spent.
        vm.prank(alice);
        token.approve(bob, 30);
        vm.prank(bob);
        token.transferFrom(alice, bob, 30);

        assertEq(token.balanceOf(bob), 80);
    }

    /// @notice Setting the allowance to zero first closes the race, because the spender can then spend only what is left.
    function test_ApprovingZeroFirstLeavesNothingToRaceOver() public {
        vm.prank(alice);
        token.approve(bob, 50);

        // Alice sends approve(bob, 0), and Bob spends the 50 first. Then it lands and 0 is all that remains.
        vm.prank(bob);
        token.transferFrom(alice, bob, 50);
        vm.prank(alice);
        token.approve(bob, 0);

        assertEq(token.allowance(alice, bob), 0);
        vm.expectRevert(abi.encodeWithSelector(BareToken.InsufficientAllowance.selector, bob, 0, 30));
        vm.prank(bob);
        token.transferFrom(alice, bob, 30);
    }

    // ---------------------------------------------------------------- fuzz

    /// @notice A transfer to anyone else moves exactly the value and keeps the sum of balances equal to the supply.
    function testFuzz_TransferMovesExactlyTheValue(address recipient, uint256 value) public {
        vm.assume(recipient != alice);
        value = bound(value, 0, SUPPLY);

        vm.prank(alice);
        token.transfer(recipient, value);

        assertEq(token.balanceOf(alice), SUPPLY - value);
        assertEq(token.balanceOf(recipient), value);
        assertEq(token.balanceOf(alice) + token.balanceOf(recipient), SUPPLY);
    }

    /// @notice A transfer succeeds exactly when the value does not exceed the balance.
    function testFuzz_TransferFailsExactlyWhenTheBalanceIsShort(uint256 value) public {
        vm.prank(alice);
        (bool succeeded,) = address(token).call(abi.encodeCall(BareToken.transfer, (bob, value)));

        assertEq(succeeded, value <= SUPPLY);
    }

    /// @notice A spender can spend exactly up to the allowance, and the allowance shrinks by what was spent.
    function testFuzz_TransferFromSpendsExactlyTheValue(uint256 allowed, uint256 spent) public {
        allowed = bound(allowed, 0, SUPPLY);
        spent = bound(spent, 0, allowed);
        vm.prank(alice);
        token.approve(bob, allowed);

        vm.prank(bob);
        token.transferFrom(alice, carol, spent);

        assertEq(token.allowance(alice, bob), allowed - spent);
        assertEq(token.balanceOf(carol), spent);
        assertEq(token.balanceOf(alice), SUPPLY - spent);
    }
}
