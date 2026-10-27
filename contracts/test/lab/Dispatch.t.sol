// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {DispatchLab, StrictLab} from "./LabContracts.sol";

/// @notice S1 lab: how a contract finds the function to run from the first four bytes of calldata.
contract DispatchTest is Test {
    DispatchLab internal dispatchLab;
    StrictLab internal strictLab;

    /// @notice Deploys one contract with a fallback and one without.
    function setUp() public {
        dispatchLab = new DispatchLab();
        strictLab = new StrictLab();
    }

    /// @notice A selector is the first four bytes of the keccak-256 hash of the function signature.
    function test_SelectorIsTheFirstFourBytesOfTheSignatureHash() public view {
        assertEq(DispatchLab.add.selector, bytes4(keccak256("add(uint256,uint256)")));
    }

    /// @notice The selectors of the ERC-20 functions, which S3 implements, are fixed by their signatures.
    function test_Erc20SelectorsAreFixedBySignature() public pure {
        assertEq(bytes4(keccak256("totalSupply()")), bytes4(0x18160ddd));
        assertEq(bytes4(keccak256("balanceOf(address)")), bytes4(0x70a08231));
        assertEq(bytes4(keccak256("transfer(address,uint256)")), bytes4(0xa9059cbb));
        assertEq(bytes4(keccak256("approve(address,uint256)")), bytes4(0x095ea7b3));
        assertEq(bytes4(keccak256("transferFrom(address,address,uint256)")), bytes4(0x23b872dd));
    }

    /// @notice A call is the selector followed by each argument padded to a 32-byte word.
    function test_CallDataIsTheSelectorThenOneWordPerArgument() public view {
        bytes memory callData = abi.encodeCall(DispatchLab.add, (20, 22));

        assertEq(callData.length, 4 + 32 + 32);
        assertEq(bytes4(callData), DispatchLab.add.selector);
    }

    /// @notice Hand-built calldata reaches the function with no help from the compiler's encoder.
    function test_HandBuiltCallDataReachesTheFunction() public {
        bytes memory callData = abi.encodePacked(DispatchLab.add.selector, uint256(20), uint256(22));

        (bool succeeded, bytes memory returnedData) = address(dispatchLab).call(callData);

        assertTrue(succeeded);
        assertEq(abi.decode(returnedData, (uint256)), 42);
    }

    /// @notice Calldata beyond what the function reads is ignored.
    function test_ExtraCallDataIsIgnored() public {
        bytes memory callData = abi.encodePacked(DispatchLab.add.selector, uint256(20), uint256(22), uint256(999));

        (bool succeeded, bytes memory returnedData) = address(dispatchLab).call(callData);

        assertTrue(succeeded);
        assertEq(abi.decode(returnedData, (uint256)), 42);
    }

    /// @notice Calldata that is too short for the arguments reverts with no data.
    function test_ShortCallDataReverts() public {
        bytes memory callData = abi.encodePacked(DispatchLab.add.selector, uint256(20));

        (bool succeeded, bytes memory returnedData) = address(dispatchLab).call(callData);

        assertFalse(succeeded);
        assertEq(returnedData.length, 0);
    }

    /// @notice A selector that matches no function runs the fallback when the contract has one.
    function test_UnknownSelectorRunsTheFallback() public {
        (bool succeeded,) = address(dispatchLab).call(hex"deadbeef");

        assertTrue(succeeded);
        assertEq(dispatchLab.fallbackCallCount(), 1);
    }

    /// @notice A contract without a fallback still serves the functions it has.
    function test_ContractWithoutAFallbackStillServesItsFunctions() public view {
        assertEq(strictLab.add(20, 22), 42);
    }

    /// @notice A selector that matches no function reverts when the contract has no fallback.
    function test_UnknownSelectorRevertsWithoutAFallback() public {
        (bool succeeded, bytes memory returnedData) = address(strictLab).call(hex"deadbeef");

        assertFalse(succeeded);
        assertEq(returnedData.length, 0);
    }

    /// @notice Empty calldata with no receive function also reaches the fallback.
    function test_EmptyCallDataReachesTheFallback() public {
        (bool succeeded,) = address(dispatchLab).call("");

        assertTrue(succeeded);
        assertEq(dispatchLab.fallbackCallCount(), 1);
    }

    /// @notice A string is encoded as an offset, then its length, then its bytes padded to a full word.
    function test_DynamicArgumentsAreEncodedAsOffsetLengthAndPaddedData() public pure {
        bytes memory encoded = abi.encode(uint256(7), "hi");

        assertEq(encoded.length, 4 * 32);
        assertEq(encoded, abi.encodePacked(uint256(7), uint256(0x40), uint256(2), bytes32("hi")));
    }
}
