// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test, Vm} from "forge-std/Test.sol";
import {EventCostLab} from "./StateCostContracts.sol";

/// @notice S2 lab: what an event costs, by the Yellow Paper's log costs, set against a storage write.
contract EventCostTest is Test {
    uint256 internal constant LOG_BASE_COST = 375;
    uint256 internal constant LOG_TOPIC_COST = 375;
    uint256 internal constant LOG_DATA_COST_PER_BYTE = 8;
    uint256 internal constant FIRST_STORAGE_WRITE_COST = 22_100;
    // The few opcodes between two gas readings cost this much at most.
    uint256 internal constant MEASUREMENT_OVERHEAD = 20;
    // Solidity encodes the event's arguments and cleans the addresses before the log opcode: about 100 gas
    // with the optimizer and about 200 without it, which is how forge coverage builds.
    uint256 internal constant SOLIDITY_EMIT_OVERHEAD = 300;

    EventCostLab internal lab;

    /// @notice Deploys the contract that emits logs with a chosen number of topics and bytes of data.
    function setUp() public {
        lab = new EventCostLab();
    }

    /// @notice The cost of a log with a number of topics and bytes of data: 375, plus 375 a topic, plus 8 a byte.
    function _logCost(uint256 topicCount, uint256 dataBytes) internal pure returns (uint256) {
        return LOG_BASE_COST + LOG_TOPIC_COST * topicCount + LOG_DATA_COST_PER_BYTE * dataBytes;
    }

    /// @notice Checks a measured cost is the expected one plus no more than the given overhead.
    function _assertCost(uint256 actual, uint256 expected, uint256 allowedOverhead) internal pure {
        assertGe(actual, expected);
        assertLe(actual, expected + allowedOverhead);
    }

    /// @notice Each topic adds 375 to a log of 32 bytes of data, from none up to four.
    function test_EachTopicAddsThreeHundredSeventyFive() public {
        uint256[5] memory costs = lab.measureLogsByTopicCount();

        for (uint256 topicCount = 0; topicCount < 5; topicCount++) {
            _assertCost(costs[topicCount], _logCost(topicCount, 32), MEASUREMENT_OVERHEAD);
        }
    }

    /// @notice The measured logs are real logs with the number of topics the measurement claims.
    function test_TheMeasuredLogsHaveTheTopicsTheyClaim() public {
        vm.recordLogs();
        lab.measureLogsByTopicCount();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 5);
        for (uint256 topicCount = 0; topicCount < 5; topicCount++) {
            assertEq(logs[topicCount].topics.length, topicCount);
            assertEq(logs[topicCount].data, abi.encode(uint256(1)));
        }
    }

    /// @notice Each byte of event data costs 8 gas, so data costs far less than storage, which holds 32 bytes for 22100.
    function test_EachByteOfDataCostsEightGas() public {
        uint256 emptyCost = lab.measureLogDataSize(0);
        uint256 halfCost = lab.measureLogDataSize(64);
        uint256 fullCost = lab.measureLogDataSize(128);

        _assertCost(emptyCost, _logCost(0, 0), MEASUREMENT_OVERHEAD);
        _assertCost(halfCost, _logCost(0, 64), MEASUREMENT_OVERHEAD);
        _assertCost(fullCost, _logCost(0, 128), MEASUREMENT_OVERHEAD);
    }

    /// @notice An ERC-20 Transfer event has three topics, its signature and two indexed addresses, and one word of data.
    function test_ATransferEventCostsAboutSeventeenHundredFiftySix() public {
        uint256 cost = lab.measureTransferEvent(address(0xBEEF), 1);

        _assertCost(cost, _logCost(3, 32), SOLIDITY_EMIT_OVERHEAD);
        assertLt(cost * 10, FIRST_STORAGE_WRITE_COST);
    }

    /// @notice The event the lab emits carries the sender, the recipient and the amount it was given.
    function test_TransferEventCarriesSenderRecipientAndAmount() public {
        address recipient = address(0xBEEF);

        vm.expectEmit(true, true, false, true, address(lab));
        emit EventCostLab.Transfer(address(this), recipient, 123);
        lab.measureTransferEvent(recipient, 123);
    }

    /// @notice The Transfer event the lab emits has the shape the ERC-20 standard fixes, which S3 relies on.
    function test_TransferEventSignatureMatchesTheErc20Standard() public pure {
        assertEq(keccak256("Transfer(address,address,uint256)"), EventCostLab.Transfer.selector);
    }
}
