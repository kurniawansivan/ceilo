// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test, Vm} from "forge-std/Test.sol";
import {StorageCostLab} from "./StateCostContracts.sol";

/// @notice S2 lab: what reading and writing storage costs, by EIP-2200, EIP-2929, EIP-3529 and EIP-1153.
contract StorageCostTest is Test {
    // EIP-2929.
    uint256 internal constant COLD_SLOAD_COST = 2100;
    uint256 internal constant COLD_ACCOUNT_ACCESS_COST = 2600;
    uint256 internal constant WARM_STORAGE_READ_COST = 100;
    // EIP-2200, with the reset cost lowered by EIP-2929 to 5000 - COLD_SLOAD_COST.
    uint256 internal constant SSTORE_SET_GAS = 20_000;
    uint256 internal constant SSTORE_RESET_GAS = 2900;
    // EIP-3529.
    uint256 internal constant SSTORE_CLEARS_SCHEDULE = 4800;
    // EIP-1153.
    uint256 internal constant TRANSIENT_ACCESS_COST = 100;
    // The few opcodes between two gas readings (the readings, a push and a pop) cost this much at most.
    uint256 internal constant MEASUREMENT_OVERHEAD = 20;

    uint256 internal constant CLEAN_SLOT = 1;
    uint256 internal constant CLEARED_SLOT = 2;
    uint256 internal constant FRESH_SLOT = 3;
    uint256 internal constant ORIGINAL_VALUE = 5;
    // Enough fresh writes, at 22100 each, that a fifth of the gas used exceeds the 19900 refund being tested.
    uint256 internal constant PADDING_WRITES = 6;
    // EIP-3529.
    uint256 internal constant MAX_REFUND_QUOTIENT = 5;

    StorageCostLab internal lab;

    /// @notice Gives two slots a value before the test starts, so the test sees them as holding a committed value.
    function setUp() public {
        lab = new StorageCostLab();
        lab.setSlot(CLEAN_SLOT, ORIGINAL_VALUE);
        lab.setSlot(CLEARED_SLOT, ORIGINAL_VALUE);
    }

    /// @notice The two slots the tests rely on hold their value before each test, and an untouched slot holds nothing.
    function test_SetUpLeavesTheFilledSlotsHoldingTheirValue() public view {
        assertEq(lab.slotValue(CLEAN_SLOT), ORIGINAL_VALUE);
        assertEq(lab.slotValue(CLEARED_SLOT), ORIGINAL_VALUE);
        assertEq(lab.slotValue(FRESH_SLOT), 0);
    }

    /// @notice Checks a measured cost is the expected one plus no more than the measurement overhead.
    function _assertCost(uint256 actual, uint256 expected) internal pure {
        assertGe(actual, expected);
        assertLe(actual, expected + MEASUREMENT_OVERHEAD);
    }

    /// @notice Makes a slot of the lab cold, as it is at the start of a transaction.
    function _coolSlot(uint256 slot) internal {
        vm.coolSlot(address(lab), bytes32(slot));
    }

    /// @notice The first read of a slot in a transaction costs 2100, and the next read of it costs 100.
    function test_ColdLoadCostsTwoThousandOneHundredAndWarmLoadOneHundred() public {
        _coolSlot(CLEAN_SLOT);

        (uint256 coldCost, uint256 warmCost,) = lab.measureLoadTwice(CLEAN_SLOT);

        _assertCost(coldCost, COLD_SLOAD_COST);
        _assertCost(warmCost, WARM_STORAGE_READ_COST);
    }

    /// @notice A different slot of the same contract is cold on its own: warmth belongs to the slot, not the contract.
    function test_WarmthBelongsToTheSlotNotTheContract() public {
        _coolSlot(CLEAN_SLOT);
        _coolSlot(CLEARED_SLOT);

        (uint256 firstSlotCost,,) = lab.measureLoadTwice(CLEAN_SLOT);
        (uint256 otherSlotCost,,) = lab.measureLoadTwice(CLEARED_SLOT);

        _assertCost(firstSlotCost, COLD_SLOAD_COST);
        _assertCost(otherSlotCost, COLD_SLOAD_COST);
    }

    /// @notice A call that touches a slot and then reverts leaves it cold, because the access list is rolled back too.
    function test_ARevertedTouchLeavesTheSlotColdAgain() public {
        _coolSlot(CLEAN_SLOT);

        (uint256 costAfterRevertedTouch,) = lab.measureLoadAfterRevertedTouch(CLEAN_SLOT);

        _assertCost(costAfterRevertedTouch, COLD_SLOAD_COST);
    }

    /// @notice The touch inside the reverting call really read the slot, so the cold read above is the revert's doing.
    function test_TheRevertedTouchDidReadTheSlot() public {
        _coolSlot(CLEAN_SLOT);

        vm.record();
        lab.measureLoadAfterRevertedTouch(CLEAN_SLOT);
        (bytes32[] memory reads,) = vm.accesses(address(lab));

        assertEq(reads.length, 2);
    }

    /// @notice A call that touches a slot and succeeds leaves it warm, which is the contrast with the revert above.
    function test_ASuccessfulTouchLeavesTheSlotWarm() public {
        _coolSlot(CLEAN_SLOT);

        (uint256 costAfterSuccessfulTouch,) = lab.measureLoadAfterSuccessfulTouch(CLEAN_SLOT);

        _assertCost(costAfterSuccessfulTouch, WARM_STORAGE_READ_COST);
    }

    /// @notice Reading another account's code size costs 2600 the first time and 100 after that.
    function test_ColdAccountAccessCostsTwoThousandSixHundredAndWarmOneHundred() public {
        address target = address(new StorageCostLab());
        vm.cool(target);

        (uint256 coldCost, uint256 warmCost,) = lab.measureCodeSizeTwice(target);

        _assertCost(coldCost, COLD_ACCOUNT_ACCESS_COST);
        _assertCost(warmCost, WARM_STORAGE_READ_COST);
    }

    /// @notice Writing a nonzero value to an empty slot costs 20000 plus 2100 for the cold access, and then 100 per rewrite.
    function test_WritingAnEmptySlotCostsTwentyThousandPlusTheColdAccess() public {
        _coolSlot(FRESH_SLOT);

        (uint256 firstCost, uint256 secondCost, uint256 thirdCost) = lab.measureStores(FRESH_SLOT, 1, 2, 0);

        _assertCost(firstCost, SSTORE_SET_GAS + COLD_SLOAD_COST);
        _assertCost(secondCost, WARM_STORAGE_READ_COST);
        _assertCost(thirdCost, WARM_STORAGE_READ_COST);
    }

    /// @notice Putting an empty slot back to zero refunds nearly all of what the first write cost, when the call used enough gas.
    function test_RestoringAnEmptySlotRefundsTheSetCostLessOneRead() public {
        _coolSlot(FRESH_SLOT);

        lab.restoreEmptySlotAfterPadding(FRESH_SLOT, PADDING_WRITES);

        assertEq(vm.lastCallGas().gasRefunded, int64(uint64(SSTORE_SET_GAS - WARM_STORAGE_READ_COST)));
    }

    /// @notice A refund is capped at a fifth of the gas the call used, so a small call gets less than the rule gives.
    function test_RefundIsCappedAtAFifthOfTheGasUsed() public {
        _coolSlot(FRESH_SLOT);

        lab.restoreEmptySlotAfterPadding(FRESH_SLOT, 0);
        Vm.Gas memory gas = vm.lastCallGas();

        assertEq(gas.gasRefunded, int64(uint64(uint256(gas.gasTotalUsed) / MAX_REFUND_QUOTIENT)));
        assertLt(uint256(uint64(gas.gasRefunded)), SSTORE_SET_GAS - WARM_STORAGE_READ_COST);
    }

    /// @notice Changing a slot that already held a value costs 2900 plus 2100 for the cold access, not 20000.
    function test_ChangingAFilledSlotCostsTwentyNineHundredPlusTheColdAccess() public {
        _coolSlot(CLEAN_SLOT);

        (uint256 firstCost, uint256 secondCost, uint256 thirdCost) = lab.measureStores(CLEAN_SLOT, 6, 6, ORIGINAL_VALUE);

        _assertCost(firstCost, SSTORE_RESET_GAS + COLD_SLOAD_COST);
        _assertCost(secondCost, WARM_STORAGE_READ_COST);
        _assertCost(thirdCost, WARM_STORAGE_READ_COST);
    }

    /// @notice Putting a filled slot back to its original value in the same call refunds the reset cost less one read.
    function test_RestoringAFilledSlotRefundsTheResetCostLessOneRead() public {
        _coolSlot(CLEAN_SLOT);

        lab.measureStores(CLEAN_SLOT, 6, 6, ORIGINAL_VALUE);

        assertEq(vm.lastCallGas().gasRefunded, int64(uint64(SSTORE_RESET_GAS - WARM_STORAGE_READ_COST)));
    }

    /// @notice Writing the value a slot already holds still pays the access: 100 warm, 2200 cold, with no refund.
    function test_WritingTheSameValueCostsOnlyTheAccess() public {
        _coolSlot(CLEAN_SLOT);

        (uint256 firstCost, uint256 secondCost,) =
            lab.measureStores(CLEAN_SLOT, ORIGINAL_VALUE, ORIGINAL_VALUE, ORIGINAL_VALUE);

        _assertCost(firstCost, WARM_STORAGE_READ_COST + COLD_SLOAD_COST);
        _assertCost(secondCost, WARM_STORAGE_READ_COST);
        assertEq(vm.lastCallGas().gasRefunded, 0);
    }

    /// @notice A write that changes nothing costs only the access, and a real change after it costs the reset alone.
    function test_AChangeAfterAnUnchangedWriteCostsOnlyTheReset() public {
        _coolSlot(CLEAN_SLOT);

        (uint256 firstCost, uint256 secondCost, uint256 thirdCost) =
            lab.measureStores(CLEAN_SLOT, ORIGINAL_VALUE, 6, ORIGINAL_VALUE);

        _assertCost(firstCost, WARM_STORAGE_READ_COST + COLD_SLOAD_COST);
        _assertCost(secondCost, SSTORE_RESET_GAS);
        _assertCost(thirdCost, WARM_STORAGE_READ_COST);
    }

    /// @notice Clearing a filled slot costs the same as changing it and earns a refund of 4800.
    function test_ClearingAFilledSlotCostsTheResetAndRefundsFortyEightHundred() public {
        _coolSlot(CLEARED_SLOT);

        (uint256 firstCost, uint256 secondCost,) = lab.measureStores(CLEARED_SLOT, 0, 0, 0);

        _assertCost(firstCost, SSTORE_RESET_GAS + COLD_SLOAD_COST);
        _assertCost(secondCost, WARM_STORAGE_READ_COST);
        assertEq(vm.lastCallGas().gasRefunded, int64(uint64(SSTORE_CLEARS_SCHEDULE)));
    }

    /// @notice Transient storage costs 100 per write and per read, against 22100 for a first write to storage.
    function test_TransientStorageCostsOneHundredPerAccess() public {
        (uint256 storeCost, uint256 loadCost,) = lab.measureTransientTwice();

        _assertCost(storeCost, TRANSIENT_ACCESS_COST);
        _assertCost(loadCost, TRANSIENT_ACCESS_COST);
        assertGt(SSTORE_SET_GAS + COLD_SLOAD_COST, 200 * storeCost);
    }

    /// @notice A transient write made by one call is visible to a later call inside the same transaction.
    function test_TransientWriteIsVisibleToALaterCallInTheSameTransaction() public {
        assertEq(lab.transientValueAfterSeparateCalls(7), 7);
    }

    /// @notice Forge treats each call from a test as its own transaction, so transient storage does not carry over.
    function test_ForgeClearsTransientStorageBetweenCallsFromATest() public {
        lab.writeTransient(7);

        assertEq(lab.readTransient(), 0);
    }

    /// @notice A transient write made inside a call that reverts is undone, like a storage write.
    function test_TransientWriteInARevertedCallIsUndone() public {
        assertEq(lab.transientValueAfterRevertedWrite(7), 0);
    }

    /// @notice Transient storage is separate from storage: writing one does not change the other.
    function test_TransientStorageIsSeparateFromStorage() public {
        (uint256 transientHeld, uint256 storageHeld) = lab.writeTransientAndReadBoth(7);

        assertEq(transientHeld, 7);
        assertEq(storageHeld, 0);
    }
}
