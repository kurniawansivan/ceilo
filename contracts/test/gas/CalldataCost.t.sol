// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestUSD} from "../../src/TestUSD.sol";

/// @notice Calls another contract the way a contract does, so no transaction cost is charged to it.
contract Caller {
    /// @notice Calls the target with no data and reports the gas the call cost.
    function measureCallTo(address target) external returns (uint256 gasUsed) {
        uint256 gasBefore = gasleft();
        (bool succeeded,) = target.call("");
        succeeded;
        gasUsed = gasBefore - gasleft();
    }
}

/// @notice What calldata costs in a call that forge charges like a transaction: EIP-2028 pricing and the EIP-7623 floor.
contract CalldataCostTest is Test {
    // The part every transaction pays before anything runs.
    uint256 internal constant TRANSACTION_BASE_COST = 21_000;
    // EIP-7623: a zero byte is one token and a non-zero byte is four, and the floor is ten gas a token.
    uint256 internal constant FLOOR_COST_PER_TOKEN = 10;
    uint256 internal constant TOKENS_PER_NON_ZERO_BYTE = 4;
    // EIP-7623 restates the usual price: four gas a token, so four a zero byte and sixteen a non-zero byte.
    uint256 internal constant STANDARD_COST_PER_ZERO_BYTE = 4;
    uint256 internal constant STANDARD_COST_PER_NON_ZERO_BYTE = 16;

    address internal stopper = makeAddr("stopper");

    /// @notice Puts a contract at the address that does nothing at all but stop.
    function setUp() public {
        vm.etch(stopper, hex"00");
    }

    /// @notice Calls a target from the test with the given data and returns the gas the call used, as forge counts it.
    function _gasOfCall(address target, bytes memory callData) internal returns (uint256) {
        vm.cool(target);
        (bool succeeded,) = target.call(callData);
        assertTrue(succeeded);
        return vm.lastFrameGas().gasTotalUsed;
    }

    /// @notice Builds data of a length that is all zero bytes, or all non-zero bytes.
    function _filled(uint256 length, bool nonZero) internal pure returns (bytes memory data) {
        data = new bytes(length);
        if (nonZero) {
            for (uint256 index = 0; index < length; index++) {
                data[index] = 0xff;
            }
        }
    }

    /// @notice A call the test contract makes pays the 21000 a transaction pays, and a call between contracts does not.
    function test_CallsFromTheTestPayTheTransactionBaseAndCallsBetweenContractsDoNot() public {
        uint256 fromTheTest = _gasOfCall(stopper, "");
        Caller caller = new Caller();
        uint256 betweenContracts = caller.measureCallTo(stopper);

        assertGe(fromTheTest, TRANSACTION_BASE_COST);
        assertLt(fromTheTest, TRANSACTION_BASE_COST + 1_000);
        assertLt(betweenContracts, 5_000);
    }

    /// @notice A call that does almost nothing but carries a lot of data pays the floor, ten gas a token, not four.
    function test_AnEmptyContractWithManyZeroBytesPaysTheFloor() public {
        uint256 totalGas = _gasOfCall(stopper, _filled(1_000, false));

        uint256 floorCost = TRANSACTION_BASE_COST + FLOOR_COST_PER_TOKEN * 1_000;
        uint256 standardCost = TRANSACTION_BASE_COST + STANDARD_COST_PER_ZERO_BYTE * 1_000;
        assertGe(totalGas, floorCost);
        assertGt(totalGas, standardCost + 5_000);
    }

    /// @notice Under the floor a non-zero byte costs forty and a zero byte ten, so a hundred of each differ by 3000.
    function test_UnderTheFloorANonZeroByteCostsThirtyMoreThanAZeroByte() public {
        uint256 zeroBytesCost = _gasOfCall(stopper, _filled(100, false));
        uint256 nonZeroBytesCost = _gasOfCall(stopper, _filled(100, true));

        assertEq(nonZeroBytesCost - zeroBytesCost, 100 * FLOOR_COST_PER_TOKEN * (TOKENS_PER_NON_ZERO_BYTE - 1));
    }

    /// @notice A call that does real work pays the standard price, where a non-zero byte costs twelve more than a zero byte.
    function test_UnderStandardPricingANonZeroByteCostsTwelveMoreThanAZeroByte() public {
        TestUSD firstToken = new TestUSD(address(this));
        TestUSD secondToken = new TestUSD(address(this));
        address spender = makeAddr("spender");

        // Approving 1 puts 31 zero bytes and one non-zero byte in the amount's word; approving the maximum puts in 32 non-zero bytes.
        uint256 smallAmountCost = _gasOfCall(address(firstToken), abi.encodeCall(IERC20.approve, (spender, 1)));
        uint256 largeAmountCost =
            _gasOfCall(address(secondToken), abi.encodeCall(IERC20.approve, (spender, type(uint256).max)));

        assertEq(
            largeAmountCost - smallAmountCost, 31 * (STANDARD_COST_PER_NON_ZERO_BYTE - STANDARD_COST_PER_ZERO_BYTE)
        );
    }
}
