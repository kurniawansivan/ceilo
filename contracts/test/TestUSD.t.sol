// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test, Vm, stdError} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TestUSD} from "../src/TestUSD.sol";

/// @notice The test stablecoin: six decimals, mint for its owner only, and OpenZeppelin's ERC-20 behaviour.
contract TestUSDTest is Test {
    uint256 internal constant SUPPLY = 1_000_000e6;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    TestUSD internal token;

    /// @notice Deploys the token with an owner and mints the whole test supply to Alice.
    function setUp() public {
        token = new TestUSD(owner);
        vm.prank(owner);
        token.mint(alice, SUPPLY);
    }

    // ---------------------------------------------------------------- metadata and ownership

    /// @notice The token has its name, symbol and owner, and starts with no supply of its own.
    function test_ConstructorSetsMetadataAndOwner() public {
        TestUSD fresh = new TestUSD(owner);

        assertEq(fresh.name(), "Ceilo Test USD");
        assertEq(fresh.symbol(), "tUSD");
        assertEq(fresh.owner(), owner);
        assertEq(fresh.totalSupply(), 0);
    }

    /// @notice The token counts in six decimals like USDC, where OpenZeppelin's default is eighteen.
    function test_DecimalsAreSix() public view {
        assertEq(token.decimals(), 6);
    }

    /// @notice A token with no owner could never mint, so the constructor refuses the zero address.
    function test_ConstructorRejectsTheZeroAddressAsOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new TestUSD(address(0));
    }

    // ---------------------------------------------------------------- mint

    /// @notice The owner can mint, which raises the recipient's balance and the total supply by the amount.
    function test_OwnerMintsToAnAddress() public {
        vm.prank(owner);
        token.mint(bob, 250e6);

        assertEq(token.balanceOf(bob), 250e6);
        assertEq(token.totalSupply(), SUPPLY + 250e6);
    }

    /// @notice A mint emits Transfer from the zero address, which is how indexers see new supply.
    function test_MintEmitsATransferFromTheZeroAddress() public {
        vm.expectEmit(true, true, false, true, address(token));
        emit IERC20.Transfer(address(0), bob, 250e6);

        vm.prank(owner);
        token.mint(bob, 250e6);
    }

    /// @notice Minting zero succeeds and still emits Transfer, like any zero-value movement.
    function test_MintingZeroSucceedsAndEmits() public {
        vm.expectEmit(true, true, false, true, address(token));
        emit IERC20.Transfer(address(0), bob, 0);

        vm.prank(owner);
        token.mint(bob, 0);

        assertEq(token.totalSupply(), SUPPLY);
    }

    /// @notice Anyone but the owner is refused, and nothing changes.
    function test_NonOwnerCannotMint() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        token.mint(alice, 1);

        assertEq(token.totalSupply(), SUPPLY);
    }

    /// @notice Minting to the zero address would burn the coins at birth, so it is refused.
    function test_CannotMintToTheZeroAddress() public {
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        vm.prank(owner);
        token.mint(address(0), 1);
    }

    /// @notice The total supply cannot pass the largest number, so minting beyond it reverts instead of wrapping.
    function test_MintBeyondTheLargestSupplyReverts() public {
        vm.prank(owner);
        token.mint(bob, type(uint256).max - SUPPLY);

        vm.expectRevert(stdError.arithmeticError);
        vm.prank(owner);
        token.mint(bob, 1);
    }

    /// @notice Ownership can move, after which the new owner mints and the old one cannot.
    function test_MintingFollowsOwnership() public {
        vm.prank(owner);
        token.transferOwnership(bob);

        vm.prank(bob);
        token.mint(carol, 5e6);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        vm.prank(owner);
        token.mint(carol, 5e6);

        assertEq(token.balanceOf(carol), 5e6);
    }

    /// @notice Once the owner gives up ownership, nobody can mint again and the supply is fixed for good.
    function test_RenouncingOwnershipFixesTheSupply() public {
        vm.prank(owner);
        token.renounceOwnership();

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        vm.prank(owner);
        token.mint(bob, 1);
    }

    /// @notice Only the owner can mint, whoever else tries and however much.
    function testFuzz_OnlyTheOwnerCanMint(address caller, uint256 amount) public {
        vm.assume(caller != owner);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        vm.prank(caller);
        token.mint(bob, amount);
    }

    // ---------------------------------------------------------------- transfer

    /// @notice The token answers every ERC-20 call through OpenZeppelin's IERC20.
    function test_TokenSpeaksTheErc20Interface() public {
        IERC20 erc20 = IERC20(address(token));

        assertEq(erc20.totalSupply(), SUPPLY);
        vm.prank(alice);
        assertTrue(erc20.transfer(bob, 10e6));
        vm.prank(alice);
        assertTrue(erc20.approve(bob, 5e6));
        vm.prank(bob);
        assertTrue(erc20.transferFrom(alice, carol, 5e6));
        assertEq(erc20.balanceOf(carol), 5e6);
    }

    /// @notice A transfer moves the value, emits Transfer and leaves the total alone.
    function test_TransferMovesTheValueAndEmits() public {
        vm.expectEmit(true, true, false, true, address(token));
        emit IERC20.Transfer(alice, bob, 100e6);

        vm.prank(alice);
        assertTrue(token.transfer(bob, 100e6));

        assertEq(token.balanceOf(alice), SUPPLY - 100e6);
        assertEq(token.balanceOf(bob), 100e6);
        assertEq(token.totalSupply(), SUPPLY);
    }

    /// @notice A transfer of zero succeeds and emits Transfer.
    function test_ZeroValueTransferSucceedsAndEmits() public {
        vm.expectEmit(true, true, false, true, address(token));
        emit IERC20.Transfer(alice, bob, 0);

        vm.prank(alice);
        assertTrue(token.transfer(bob, 0));
    }

    /// @notice A transfer of more than the balance reverts with the ERC-6093 error and changes nothing.
    function test_TransferOfMoreThanTheBalanceReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, SUPPLY, SUPPLY + 1)
        );
        vm.prank(alice);
        token.transfer(bob, SUPPLY + 1);

        assertEq(token.balanceOf(alice), SUPPLY);
        assertEq(token.balanceOf(bob), 0);
    }

    /// @notice Sending to oneself leaves the balance as it was.
    function test_TransferToOneselfChangesNothing() public {
        vm.prank(alice);
        token.transfer(alice, 100e6);

        assertEq(token.balanceOf(alice), SUPPLY);
    }

    /// @notice Unlike the bare token, sending to the zero address is refused, so no tokens are lost to it by accident.
    function test_TransferToTheZeroAddressReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        vm.prank(alice);
        token.transfer(address(0), 100e6);

        assertEq(token.balanceOf(alice), SUPPLY);
    }

    // ---------------------------------------------------------------- approve

    /// @notice Approving sets the allowance and emits Approval.
    function test_ApproveSetsTheAllowanceAndEmits() public {
        vm.expectEmit(true, true, false, true, address(token));
        emit IERC20.Approval(alice, bob, 50e6);

        vm.prank(alice);
        assertTrue(token.approve(bob, 50e6));

        assertEq(token.allowance(alice, bob), 50e6);
    }

    /// @notice A second approval replaces the first.
    function test_ApproveOverwritesThePreviousAllowance() public {
        vm.startPrank(alice);
        token.approve(bob, 50e6);
        token.approve(bob, 30e6);
        vm.stopPrank();

        assertEq(token.allowance(alice, bob), 30e6);
    }

    /// @notice Unlike the bare token, approving the zero address as spender is refused.
    function test_ApproveRejectsTheZeroAddressAsSpender() public {
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidSpender.selector, address(0)));
        vm.prank(alice);
        token.approve(address(0), 1);
    }

    // ---------------------------------------------------------------- transferFrom

    /// @notice A spender moves the owner's tokens, the allowance shrinks, and only Transfer is emitted.
    function test_TransferFromSpendsTheAllowanceAndEmitsOnlyTransfer() public {
        vm.prank(alice);
        token.approve(bob, 50e6);

        vm.recordLogs();
        vm.prank(bob);
        assertTrue(token.transferFrom(alice, carol, 30e6));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], IERC20.Transfer.selector);
        assertEq(token.allowance(alice, bob), 20e6);
        assertEq(token.balanceOf(carol), 30e6);
    }

    /// @notice A spender cannot move more than the allowance.
    function test_TransferFromBeyondTheAllowanceReverts() public {
        vm.prank(alice);
        token.approve(bob, 50e6);

        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, bob, 50e6, 51e6));
        vm.prank(bob);
        token.transferFrom(alice, carol, 51e6);

        assertEq(token.allowance(alice, bob), 50e6);
    }

    /// @notice When both the allowance and the balance fall short, the allowance error is the one reported.
    function test_AllowanceIsCheckedBeforeTheBalance() public {
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, carol, 0, 1));
        vm.prank(carol);
        token.transferFrom(bob, alice, 1);
    }

    /// @notice An allowance larger than the owner's balance does not let the spender move more than the balance.
    function test_TransferFromBeyondTheBalanceRevertsEvenWithAnAllowance() public {
        vm.prank(bob);
        token.approve(carol, 1_000e6);

        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, bob, 0, 1));
        vm.prank(carol);
        token.transferFrom(bob, alice, 1);

        assertEq(token.allowance(bob, carol), 1_000e6);
    }

    /// @notice A transferFrom of zero needs no allowance and emits Transfer.
    function test_ZeroValueTransferFromNeedsNoAllowance() public {
        vm.expectEmit(true, true, false, true, address(token));
        emit IERC20.Transfer(alice, carol, 0);

        vm.prank(bob);
        assertTrue(token.transferFrom(alice, carol, 0));
    }

    /// @notice An owner has no special right through transferFrom: it needs an allowance from itself.
    function test_OwnerNeedsAnAllowanceFromItselfToUseTransferFrom() public {
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, alice, 0, 10));
        vm.prank(alice);
        token.transferFrom(alice, bob, 10);
    }

    /// @notice Unlike the bare token, a maximum allowance is unlimited: spending it leaves it at the maximum.
    function test_MaximumAllowanceIsNeverSpent() public {
        vm.prank(alice);
        token.approve(bob, type(uint256).max);

        vm.prank(bob);
        token.transferFrom(alice, carol, 100e6);

        assertEq(token.allowance(alice, bob), type(uint256).max);
    }

    /// @notice Just under the maximum is spent normally, so only the exact maximum is special.
    function test_AllowanceJustUnderTheMaximumIsSpent() public {
        vm.prank(alice);
        token.approve(bob, type(uint256).max - 1);

        vm.prank(bob);
        token.transferFrom(alice, carol, 100e6);

        assertEq(token.allowance(alice, bob), type(uint256).max - 1 - 100e6);
    }

    /// @notice OpenZeppelin v5 does not fix the approve race: a spender acting between two approvals spends both.
    function test_ApproveRaceStillLetsASpenderSpendBothAllowances() public {
        vm.prank(alice);
        token.approve(bob, 50e6);

        vm.prank(bob);
        token.transferFrom(alice, bob, 50e6);
        vm.prank(alice);
        token.approve(bob, 30e6);
        vm.prank(bob);
        token.transferFrom(alice, bob, 30e6);

        assertEq(token.balanceOf(bob), 80e6);
    }

    // ---------------------------------------------------------------- fuzz

    /// @notice A transfer to anyone but the sender moves exactly the value and keeps the total supply.
    function testFuzz_TransferMovesExactlyTheValue(address recipient, uint256 value) public {
        vm.assume(recipient != alice && recipient != address(0));
        value = bound(value, 0, SUPPLY);

        vm.prank(alice);
        token.transfer(recipient, value);

        assertEq(token.balanceOf(alice), SUPPLY - value);
        assertEq(token.balanceOf(recipient), value);
        assertEq(token.totalSupply(), SUPPLY);
    }

    /// @notice A spender spends exactly the value from an allowance that is not the maximum.
    function testFuzz_TransferFromSpendsExactlyTheValue(uint256 allowed, uint256 spent) public {
        allowed = bound(allowed, 0, SUPPLY);
        spent = bound(spent, 0, allowed);
        vm.prank(alice);
        token.approve(bob, allowed);

        vm.prank(bob);
        token.transferFrom(alice, carol, spent);

        assertEq(token.allowance(alice, bob), allowed - spent);
        assertEq(token.balanceOf(carol), spent);
    }
}
