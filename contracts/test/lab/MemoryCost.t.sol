// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {MemoryCostLab} from "./StateCostContracts.sol";

/// @notice S2 lab: memory is cheap to start using and quadratic to grow, by the Yellow Paper's formula.
contract MemoryCostTest is Test {
    uint256 internal constant GAS_PER_WORD = 3;
    uint256 internal constant QUADRATIC_DIVISOR = 512;
    // The arithmetic that computes the offset, and the store itself, cost this much at most beyond the expansion.
    uint256 internal constant MEASUREMENT_OVERHEAD = 60;

    MemoryCostLab internal lab;

    /// @notice Deploys the contract that grows its own memory and measures what each growth costs.
    function setUp() public {
        lab = new MemoryCostLab();
    }

    /// @notice The total cost of having this many 32-byte words of memory: three gas a word plus words squared over 512.
    function _memoryCost(uint256 words) internal pure returns (uint256) {
        return GAS_PER_WORD * words + (words * words) / QUADRATIC_DIVISOR;
    }

    /// @notice Checks a measured growth cost is the formula's difference plus no more than the measurement overhead.
    function _assertGrowthCost(uint256 actual, uint256 fromWords, uint256 toWords) internal pure {
        uint256 expected = _memoryCost(toWords) - _memoryCost(fromWords);
        assertGe(actual, expected);
        assertLe(actual, expected + MEASUREMENT_OVERHEAD);
    }

    /// @notice Growing from 1000 words to 2000 and then to 4000 costs what the formula says for each step.
    function test_GrowthCostFollowsTheMemoryFormula() public view {
        (, uint256 secondCost, uint256 thirdCost) = lab.growMemoryThrice(1000, 2000, 4000);

        _assertGrowthCost(secondCost, 1000, 2000);
        _assertGrowthCost(thirdCost, 2000, 4000);
    }

    /// @notice Each extra word costs more the larger memory already is, so doubling the memory more than doubles the cost.
    function test_EachExtraWordCostsMoreAsMemoryGrows() public view {
        (, uint256 secondCost, uint256 thirdCost) = lab.growMemoryThrice(1000, 2000, 4000);

        // Per word: secondCost / 1000 words against thirdCost / 2000 words, compared without dividing.
        assertGt(thirdCost * 1000, secondCost * 2000);
    }

    /// @notice Writing one word far away pays for every word of memory before it.
    function test_WritingOneFarWordPaysForAllTheWordsBeforeIt() public view {
        (uint256 firstCost,,) = lab.growMemoryThrice(1000, 1001, 1002);

        // Memory already holds a few words (the free memory pointer sits at 0x80), so the growth starts from four words.
        _assertGrowthCost(firstCost, 4, 1000);
    }

    /// @notice Writing inside memory that is already paid for costs only the store itself.
    function test_WritingInsidePaidMemoryCostsOnlyTheStore() public view {
        (, uint256 secondCost,) = lab.growMemoryThrice(1000, 500, 400);

        assertLe(secondCost, MEASUREMENT_OVERHEAD);
    }
}
