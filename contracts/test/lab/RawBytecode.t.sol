// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {stdError} from "forge-std/StdError.sol";

/// @notice S1 lab: contracts written as raw opcodes, to show what the EVM does without Solidity.
contract RawBytecodeTest is Test {
    // PUSH1 0x2a, PUSH1 0x00, MSTORE, PUSH1 0x20, PUSH1 0x00, RETURN: returns the word 42.
    bytes internal constant RETURN_FORTY_TWO = hex"602a60005260206000f3";
    // PUSH1 0, CALLDATALOAD, PUSH1 0x20, CALLDATALOAD, ADD, then store and return the sum.
    bytes internal constant ADD_TWO_WORDS = hex"6000356020350160005260206000f3";
    // INVALID: the designated invalid opcode.
    bytes internal constant INVALID_OPCODE = hex"fe";
    // ADD with an empty stack: an exceptional halt.
    bytes internal constant ADD_WITH_EMPTY_STACK = hex"01";
    // STOP: ends the call cleanly at once, which gives a baseline cost for any call to this code.
    bytes internal constant STOP_OPCODE = hex"00";
    // PUSH1 0, PUSH1 0, REVERT: reverts with no data.
    bytes internal constant REVERT_WITH_NO_DATA = hex"60006000fd";

    uint256 internal constant GAS_GIVEN = 100_000;
    address internal target = makeAddr("rawBytecodeTarget");

    /// @notice Calls the target with a fixed gas limit and returns what the call cost its caller.
    function _callAndMeasure(bytes memory callData)
        internal
        returns (bool succeeded, bytes memory returnedData, uint256 gasConsumed)
    {
        uint256 gasBefore = gasleft();
        (succeeded, returnedData) = target.call{gas: GAS_GIVEN}(callData);
        gasConsumed = gasBefore - gasleft();
    }

    /// @notice Code that pushes 42, stores it in memory and returns that word answers 42 to any call.
    function test_HandWrittenBytecodeReturnsFortyTwo() public {
        vm.etch(target, RETURN_FORTY_TWO);

        (bool succeeded, bytes memory returnedData,) = _callAndMeasure("");

        assertTrue(succeeded);
        assertEq(abi.decode(returnedData, (uint256)), 42);
    }

    /// @notice The same code answers 42 whatever calldata it receives, because it never reads any.
    function test_BytecodeThatIgnoresCalldataAnswersEveryCall() public {
        vm.etch(target, RETURN_FORTY_TWO);

        (, bytes memory returnedData,) = _callAndMeasure(hex"deadbeef");

        assertEq(abi.decode(returnedData, (uint256)), 42);
    }

    /// @notice Code that loads two calldata words and adds them returns their sum.
    function test_HandWrittenAdderAddsTwoCalldataWords() public {
        vm.etch(target, ADD_TWO_WORDS);

        (bool succeeded, bytes memory returnedData,) = _callAndMeasure(abi.encode(uint256(20), uint256(22)));

        assertTrue(succeeded);
        assertEq(abi.decode(returnedData, (uint256)), 42);
    }

    /// @notice The raw ADD opcode wraps around at 2^256 and never reverts.
    function test_RawAddWrapsAroundWithoutAnyCheck() public {
        vm.etch(target, ADD_TWO_WORDS);

        (bool succeeded, bytes memory returnedData,) = _callAndMeasure(abi.encode(type(uint256).max, uint256(1)));

        assertTrue(succeeded);
        assertEq(abi.decode(returnedData, (uint256)), 0);
    }

    /// @notice Solidity 0.8 adds the overflow check that the raw opcode lacks.
    function test_SolidityAddRevertsWhereRawAddWraps() public {
        vm.expectRevert(stdError.arithmeticError);
        this.checkedAdd(type(uint256).max, 1);
    }

    /// @notice An external wrapper around checked addition, so the revert can be observed as a call failing.
    function checkedAdd(uint256 first, uint256 second) external pure returns (uint256) {
        return first + second;
    }

    /// @notice The invalid opcode fails the call and burns every unit of gas it was given.
    function test_InvalidOpcodeBurnsAllGasGiven() public {
        vm.etch(target, INVALID_OPCODE);

        (bool succeeded,, uint256 gasConsumed) = _callAndMeasure("");

        assertFalse(succeeded);
        assertGe(gasConsumed, GAS_GIVEN);
    }

    /// @notice Popping an empty stack is an exceptional halt, which burns all gas like the invalid opcode.
    function test_EmptyStackBurnsAllGasGiven() public {
        vm.etch(target, ADD_WITH_EMPTY_STACK);

        (bool succeeded,, uint256 gasConsumed) = _callAndMeasure("");

        assertFalse(succeeded);
        assertGe(gasConsumed, GAS_GIVEN);
    }

    /// @notice REVERT fails the call but keeps the unused gas, costing only a few opcodes more than STOP.
    function test_RevertOpcodeReturnsUnusedGas() public {
        vm.etch(target, STOP_OPCODE);
        (,, uint256 gasConsumedByStop) = _callAndMeasure("");

        vm.etch(target, REVERT_WITH_NO_DATA);
        (bool succeeded, bytes memory returnedData, uint256 gasConsumedByRevert) = _callAndMeasure("");

        assertFalse(succeeded);
        assertEq(returnedData.length, 0);
        assertLt(gasConsumedByRevert - gasConsumedByStop, 100);
        assertLt(gasConsumedByRevert, GAS_GIVEN / 2);
    }
}
