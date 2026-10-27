// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @notice Reads and writes raw storage slots and reports what each access cost, read from the gas counter.
contract StorageCostLab {
    uint256 internal constant PADDING_FIRST_SLOT = 1000;

    /// @notice Writes a value to a storage slot, used to give a slot a committed value before a test.
    function setSlot(uint256 slot, uint256 value) external {
        assembly ("memory-safe") {
            sstore(slot, value)
        }
    }

    /// @notice Reads a storage slot.
    function slotValue(uint256 slot) external view returns (uint256 value) {
        assembly ("memory-safe") {
            value := sload(slot)
        }
    }

    /// @notice Reads one slot twice and reports the gas of each read, the first one cold and the second warm.
    /// @dev The values read are returned too: the optimizer deletes a read whose result is never used.
    function measureLoadTwice(uint256 slot)
        external
        view
        returns (uint256 coldCost, uint256 warmCost, uint256 valuesRead)
    {
        assembly ("memory-safe") {
            let gasBeforeFirstLoad := gas()
            let firstValue := sload(slot)
            let gasBeforeSecondLoad := gas()
            let secondValue := sload(slot)
            let gasAfterSecondLoad := gas()
            coldCost := sub(gasBeforeFirstLoad, gasBeforeSecondLoad)
            warmCost := sub(gasBeforeSecondLoad, gasAfterSecondLoad)
            valuesRead := add(firstValue, secondValue)
        }
    }

    /// @notice Touches a slot in an inner call that reverts, then reports the gas of reading that slot afterwards.
    function measureLoadAfterRevertedTouch(uint256 slot) external view returns (uint256 cost, uint256 valueRead) {
        try this.touchThenRevert(slot) {}
        catch {
            (cost, valueRead) = _measureOneLoad(slot);
        }
    }

    /// @notice Touches a slot in an inner call that succeeds, then reports the gas of reading that slot afterwards.
    function measureLoadAfterSuccessfulTouch(uint256 slot) external view returns (uint256 cost, uint256 valueRead) {
        this.touch(slot);
        (cost, valueRead) = _measureOneLoad(slot);
    }

    /// @notice Reads a slot and returns it, so the slot becomes warm if the call goes on to succeed.
    function touch(uint256 slot) external view returns (uint256 value) {
        assembly ("memory-safe") {
            value := sload(slot)
        }
    }

    /// @notice Reads a slot and reverts with what it read, so the read must leave no warmth behind.
    function touchThenRevert(uint256 slot) external view {
        assembly {
            mstore(0, sload(slot))
            revert(0, 32)
        }
    }

    /// @notice Reads the code size of an account twice and reports the gas of each, the first one cold and the second warm.
    function measureCodeSizeTwice(address target)
        external
        view
        returns (uint256 coldCost, uint256 warmCost, uint256 sizesRead)
    {
        assembly ("memory-safe") {
            let gasBeforeFirstRead := gas()
            let firstSize := extcodesize(target)
            let gasBeforeSecondRead := gas()
            let secondSize := extcodesize(target)
            let gasAfterSecondRead := gas()
            coldCost := sub(gasBeforeFirstRead, gasBeforeSecondRead)
            warmCost := sub(gasBeforeSecondRead, gasAfterSecondRead)
            sizesRead := add(firstSize, secondSize)
        }
    }

    /// @notice Writes three values to one slot in turn and reports the gas of each write.
    function measureStores(uint256 slot, uint256 first, uint256 second, uint256 third)
        external
        returns (uint256 firstCost, uint256 secondCost, uint256 thirdCost)
    {
        assembly ("memory-safe") {
            let gasBeforeFirstStore := gas()
            sstore(slot, first)
            let gasBeforeSecondStore := gas()
            sstore(slot, second)
            let gasBeforeThirdStore := gas()
            sstore(slot, third)
            let gasAfterThirdStore := gas()
            firstCost := sub(gasBeforeFirstStore, gasBeforeSecondStore)
            secondCost := sub(gasBeforeSecondStore, gasBeforeThirdStore)
            thirdCost := sub(gasBeforeThirdStore, gasAfterThirdStore)
        }
    }

    /// @notice Writes and reads the first transient slot and reports the gas of each.
    function measureTransientTwice() external returns (uint256 storeCost, uint256 loadCost, uint256 valueRead) {
        assembly ("memory-safe") {
            let gasBeforeStore := gas()
            tstore(0, 1)
            let gasBeforeLoad := gas()
            let value := tload(0)
            let gasAfterLoad := gas()
            storeCost := sub(gasBeforeStore, gasBeforeLoad)
            loadCost := sub(gasBeforeLoad, gasAfterLoad)
            valueRead := value
        }
    }

    /// @notice Writes the first transient slot.
    function writeTransient(uint256 value) external {
        assembly ("memory-safe") {
            tstore(0, value)
        }
    }

    /// @notice Reads the first transient slot.
    function readTransient() external view returns (uint256 value) {
        assembly ("memory-safe") {
            value := tload(0)
        }
    }

    /// @notice Writes the first transient slot in one call and reads it back in another, inside this one transaction.
    function transientValueAfterSeparateCalls(uint256 value) external returns (uint256 held) {
        this.writeTransient(value);
        held = this.readTransient();
    }

    /// @notice Writes the first transient slot and reports what the first transient slot and the first storage slot hold.
    function writeTransientAndReadBoth(uint256 value) external returns (uint256 transientHeld, uint256 storageHeld) {
        assembly ("memory-safe") {
            tstore(0, value)
            transientHeld := tload(0)
            storageHeld := sload(0)
        }
    }

    /// @notice Writes the first transient slot and then reverts, so the write must be undone.
    function writeTransientThenRevert(uint256 value) external {
        assembly ("memory-safe") {
            tstore(0, value)
            revert(0, 0)
        }
    }

    /// @notice Tries a reverting transient write and reports what the first transient slot holds afterwards.
    function transientValueAfterRevertedWrite(uint256 value) external returns (uint256 held) {
        try this.writeTransientThenRevert(value) {} catch {}
        held = this.readTransient();
    }

    /// @notice Writes some fresh slots to spend gas, then fills an empty slot and empties it again.
    /// @dev Each write is its own call, because the optimizer merges two writes to one slot that follow each other.
    function restoreEmptySlotAfterPadding(uint256 slot, uint256 paddingWrites) external {
        for (uint256 index = 0; index < paddingWrites; index++) {
            this.setSlot(PADDING_FIRST_SLOT + index, 1);
        }
        this.setSlot(slot, 1);
        this.setSlot(slot, 0);
    }

    /// @notice Reads a slot once and reports the gas it cost, with the value it read.
    function _measureOneLoad(uint256 slot) internal view returns (uint256 cost, uint256 valueRead) {
        assembly ("memory-safe") {
            let gasBeforeLoad := gas()
            let value := sload(slot)
            let gasAfterLoad := gas()
            cost := sub(gasBeforeLoad, gasAfterLoad)
            valueRead := value
        }
    }
}

/// @notice Grows its own memory and reports what each growth cost, read from the gas counter.
contract MemoryCostLab {
    /// @notice Writes one word at the end of a region of the given size three times and reports the gas of each write.
    function growMemoryThrice(uint256 firstWords, uint256 secondWords, uint256 thirdWords)
        external
        view
        returns (uint256 firstCost, uint256 secondCost, uint256 thirdCost)
    {
        assembly {
            let gasBeforeFirst := gas()
            mstore(mul(sub(firstWords, 1), 32), 1)
            let gasBeforeSecond := gas()
            mstore(mul(sub(secondWords, 1), 32), 1)
            let gasBeforeThird := gas()
            mstore(mul(sub(thirdWords, 1), 32), 1)
            let gasAfterThird := gas()
            firstCost := sub(gasBeforeFirst, gasBeforeSecond)
            secondCost := sub(gasBeforeSecond, gasBeforeThird)
            thirdCost := sub(gasBeforeThird, gasAfterThird)
        }
    }
}

/// @notice Emits logs with a chosen number of topics and bytes of data and reports what each cost.
contract EventCostLab {
    event Transfer(address indexed from, address indexed to, uint256 value);

    /// @notice Emits five logs of one word of data, with zero to four topics, and reports the gas of each.
    function measureLogsByTopicCount() external returns (uint256[5] memory costs) {
        assembly {
            mstore(0, 1)
            let gasBeforeNoTopics := gas()
            log0(0, 32)
            let gasBeforeOneTopic := gas()
            log1(0, 32, 1)
            let gasBeforeTwoTopics := gas()
            log2(0, 32, 1, 2)
            let gasBeforeThreeTopics := gas()
            log3(0, 32, 1, 2, 3)
            let gasBeforeFourTopics := gas()
            log4(0, 32, 1, 2, 3, 4)
            let gasAfterFourTopics := gas()
            mstore(costs, sub(gasBeforeNoTopics, gasBeforeOneTopic))
            mstore(add(costs, 32), sub(gasBeforeOneTopic, gasBeforeTwoTopics))
            mstore(add(costs, 64), sub(gasBeforeTwoTopics, gasBeforeThreeTopics))
            mstore(add(costs, 96), sub(gasBeforeThreeTopics, gasBeforeFourTopics))
            mstore(add(costs, 128), sub(gasBeforeFourTopics, gasAfterFourTopics))
        }
    }

    /// @notice Emits one log of the given number of data bytes, from memory that is already paid for, and reports its gas.
    function measureLogDataSize(uint256 size) external returns (uint256 cost) {
        assembly {
            mstore(96, 1)
            let gasBeforeLog := gas()
            log0(0, size)
            let gasAfterLog := gas()
            cost := sub(gasBeforeLog, gasAfterLog)
        }
    }

    /// @notice Emits an ERC-20 style Transfer event from Solidity and reports the gas of the emit statement.
    function measureTransferEvent(address to, uint256 amount) external returns (uint256 cost) {
        uint256 gasBefore = gasleft();
        emit Transfer(msg.sender, to, amount);
        cost = gasBefore - gasleft();
    }
}
