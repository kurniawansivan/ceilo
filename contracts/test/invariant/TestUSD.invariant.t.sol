// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {TestUSD} from "../../src/TestUSD.sol";
import {TestUSDHandler} from "./TestUSDHandler.sol";

/// @notice Properties of TestUSD that must hold after any sequence of calls, checked against a reference model.
contract TestUSDInvariantTest is Test {
    address internal owner = makeAddr("owner");

    TestUSD internal token;
    TestUSDHandler internal handler;

    /// @notice Deploys the token and a handler that makes the fuzzer's calls, and points the fuzzer at the handler only.
    function setUp() public {
        token = new TestUSD(owner);
        address[] memory actors = new address[](4);
        actors[0] = makeAddr("alice");
        actors[1] = makeAddr("bob");
        actors[2] = makeAddr("carol");
        actors[3] = makeAddr("dave");
        handler = new TestUSDHandler(token, owner, actors);

        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = TestUSDHandler.mint.selector;
        selectors[1] = TestUSDHandler.mintAsSomeoneElse.selector;
        selectors[2] = TestUSDHandler.transfer.selector;
        selectors[3] = TestUSDHandler.approve.selector;
        selectors[4] = TestUSDHandler.transferFrom.selector;
        selectors[5] = TestUSDHandler.mintToTheZeroAddress.selector;
        selectors[6] = TestUSDHandler.transferToTheZeroAddress.selector;
        selectors[7] = TestUSDHandler.approveTheZeroAddress.selector;
        selectors[8] = TestUSDHandler.transferFromToTheZeroAddress.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice The token and the reference model hold the same balances, allowances and supply after every call.
    function invariant_TokenMatchesTheReferenceModel() public view {
        assertEq(token.totalSupply(), handler.modelSupply());
        for (uint256 index = 0; index < handler.actorCount(); index++) {
            address holder = handler.actorAt(index);
            assertEq(token.balanceOf(holder), handler.modelBalance(holder));
            for (uint256 other = 0; other < handler.actorCount(); other++) {
                address spender = handler.actorAt(other);
                assertEq(token.allowance(holder, spender), handler.modelAllowance(holder, spender));
            }
        }
    }

    /// @notice Every call succeeded or reverted with exactly the data the model expected.
    function invariant_EveryCallEndedTheWayTheModelSaid() public view {
        assertEq(handler.disagreements(), 0);
    }

    /// @notice The supply is exactly the sum of what the holders have, so no token is created or lost by a transfer.
    function invariant_SupplyEqualsTheSumOfBalances() public view {
        uint256 sum;
        for (uint256 index = 0; index < handler.actorCount(); index++) {
            sum += token.balanceOf(handler.actorAt(index));
        }
        assertEq(sum, token.totalSupply());
    }

    /// @notice The zero address never holds anything, because nothing can be sent or minted to it.
    function invariant_ZeroAddressHoldsNothing() public view {
        assertEq(token.balanceOf(address(0)), 0);
    }

    /// @notice The supply never goes down, because nothing in the token burns.
    function invariant_SupplyNeverDecreases() public view {
        assertFalse(handler.supplyDecreased());
    }

    /// @notice The handler really mints, moves and spends tokens, so the invariants are checked on real states, not empty ones.
    function test_HandlerReachesRealStates() public {
        for (uint256 seed = 0; seed < 64; seed++) {
            handler.mint(seed, seed * 3);
            handler.approve(seed, seed + 1, seed * 5);
            handler.transfer(seed, seed + 2, seed * 7);
            handler.transferFrom(seed + 1, seed, seed + 3, seed * 11);
        }

        assertGt(handler.successfulMints(), 0);
        assertGt(handler.successfulTransfers(), 0);
        assertGt(handler.successfulSpends(), 0);
        assertGt(handler.modelSupply(), 0);
        assertEq(handler.disagreements(), 0);
    }
}
