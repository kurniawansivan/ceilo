// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {RollbackLab} from "./LabContracts.sol";

/// @notice S1 lab: a revert undoes every state change made inside the call that reverted.
contract RollbackTest is Test {
    RollbackLab internal rollbackLab;

    /// @notice Deploys the contract whose functions write state and then revert.
    function setUp() public {
        rollbackLab = new RollbackLab();
    }

    /// @notice A call that writes and then reverts leaves the state as it was.
    function test_RevertUndoesTheWritesOfThatCall() public {
        vm.expectRevert(abi.encodeWithSelector(RollbackLab.Boom.selector, 7));
        rollbackLab.writeThenRevert();

        assertEq(rollbackLab.value(), 0);
    }

    /// @notice Revert data is the error selector followed by its arguments, so errors are ABI-encoded like calls.
    function test_RevertDataIsTheErrorSelectorAndItsArguments() public {
        (bool succeeded, bytes memory returnedData) =
            address(rollbackLab).call(abi.encodeCall(RollbackLab.writeThenRevert, ()));

        assertFalse(succeeded);
        assertEq(returnedData, abi.encodeWithSelector(RollbackLab.Boom.selector, 7));
        assertEq(returnedData.length, 4 + 32);
    }

    /// @notice A caller that catches the revert keeps its own earlier writes and loses only the inner ones.
    function test_CatchingARevertKeepsTheCallersWritesAndLosesTheInnerOnes() public {
        rollbackLab.writeThenCatch();

        assertEq(rollbackLab.value(), 2);
        assertTrue(rollbackLab.caught());
    }

    /// @notice A revert passes up through every caller that does not catch it, undoing all of their writes too.
    function test_AnUncaughtRevertUndoesTheWholeCallChain() public {
        vm.expectRevert(abi.encodeWithSelector(RollbackLab.Boom.selector, 7));
        rollbackLab.writeThenCallRevertingFunction();

        assertEq(rollbackLab.value(), 0);
    }

    /// @notice The writes of a reverted call did run, and were undone afterwards: a recorded write leaves no trace in state.
    function test_TheWritesRanBeforeTheyWereUndone() public {
        vm.record();
        vm.expectRevert(abi.encodeWithSelector(RollbackLab.Boom.selector, 7));
        rollbackLab.writeThenCallRevertingFunction();
        (, bytes32[] memory writes) = vm.accesses(address(rollbackLab));

        assertEq(writes.length, 2);
        assertEq(rollbackLab.value(), 0);
    }

    /// @notice A successful call keeps its writes, which makes the three tests above a real contrast.
    function test_ASuccessfulCallKeepsItsWrites() public {
        rollbackLab.writeOnly();

        assertEq(rollbackLab.value(), 5);
    }
}
