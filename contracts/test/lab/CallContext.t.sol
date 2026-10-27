// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {CallerLab, LogicLab, MismatchedCallerLab} from "./LabContracts.sol";

/// @notice S1 lab: call, delegatecall and staticcall run the same code in different contexts.
contract CallContextTest is Test {
    LogicLab internal logicLab;
    CallerLab internal callerLab;

    /// @notice Deploys a logic contract and a caller that has the same storage layout.
    function setUp() public {
        logicLab = new LogicLab();
        callerLab = new CallerLab(address(logicLab));
    }

    /// @notice A call changes the storage of the contract that was called, and sees the caller as msg.sender.
    function test_CallRunsInTheContextOfTheCalledContract() public {
        callerLab.viaCall(5);

        assertEq(logicLab.value(), 5);
        assertEq(logicLab.lastCaller(), address(callerLab));
        assertEq(callerLab.value(), 0);
    }

    /// @notice A delegatecall changes the caller's own storage, and msg.sender stays the original sender.
    function test_DelegatecallRunsTheCodeAgainstTheCallersStorage() public {
        callerLab.viaDelegatecall(5);

        assertEq(callerLab.value(), 5);
        assertEq(callerLab.lastCaller(), address(this));
        assertEq(logicLab.value(), 0);
        assertEq(logicLab.lastCaller(), address(0));
    }

    /// @notice A staticcall to a function that writes state fails, burns all the gas it was given, and changes nothing.
    function test_StaticcallRefusesToWriteState() public {
        uint256 gasBefore = gasleft();
        bool succeeded = callerLab.viaStaticcall(5);
        uint256 gasConsumed = gasBefore - gasleft();

        assertFalse(succeeded);
        assertGe(gasConsumed, 100_000);
        assertLt(gasConsumed, 110_000);
        assertEq(logicLab.value(), 0);
    }

    /// @notice A staticcall to a function that only reads state succeeds.
    function test_StaticcallAllowsReadingState() public {
        callerLab.viaCall(9);

        assertEq(callerLab.readViaStaticcall(), 9);
    }

    /// @notice Delegatecall writes by storage slot, so a caller with another layout has its own variables overwritten.
    function test_DelegatecallWritesBySlotNotByName() public {
        MismatchedCallerLab mismatched = new MismatchedCallerLab(address(logicLab));

        mismatched.viaDelegatecall(5);

        assertEq(mismatched.owner(), address(uint160(5)));
        assertEq(mismatched.counter(), uint256(uint160(address(this))));
    }
}
