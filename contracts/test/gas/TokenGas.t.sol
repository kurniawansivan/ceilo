// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BareToken} from "../lab/BareToken.sol";
import {TestUSD} from "../../src/TestUSD.sol";

/// @notice What the ERC-20 calls cost, in the bare token and in the OpenZeppelin one, and why, from the storage rules.
contract TokenGasTest is Test {
    uint256 internal constant SUPPLY = 1_000_000e6;
    uint256 internal constant TRANSACTION_BASE_COST = 21_000;
    // The first write to an empty slot costs 20000 and a write to a filled one 2900, both on top of the cold access.
    uint256 internal constant FIRST_WRITE_EXTRA_COST = 20_000 - 2900;
    // Rewriting the allowance of a spender who is allowed less than the maximum costs this write on top of the rest.
    uint256 internal constant ALLOWANCE_WRITE_COST = 2900;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal finiteSpender = makeAddr("finiteSpender");
    address internal unlimitedSpender = makeAddr("unlimitedSpender");

    IERC20 internal bareToken;
    IERC20 internal openZeppelinToken;

    /// @notice Gives both tokens the same start: Alice holds everything, Bob a little, and two spenders have allowances.
    function setUp() public {
        vm.prank(alice);
        bareToken = IERC20(address(new BareToken("Bare", "BARE", 6, SUPPLY)));
        TestUSD testUsd = new TestUSD(owner);
        vm.prank(owner);
        testUsd.mint(alice, SUPPLY);
        openZeppelinToken = IERC20(address(testUsd));

        IERC20[2] memory tokens = [bareToken, openZeppelinToken];
        for (uint256 index = 0; index < tokens.length; index++) {
            vm.startPrank(alice);
            tokens[index].transfer(bob, 1_000);
            tokens[index].approve(finiteSpender, 1_000_000);
            tokens[index].approve(unlimitedSpender, type(uint256).max);
            vm.stopPrank();
        }
    }

    /// @notice The gas of the call data as a transaction pays it: four for a zero byte and sixteen for any other.
    function _callDataGas(bytes memory callData) internal pure returns (uint256 gasUsed) {
        for (uint256 index = 0; index < callData.length; index++) {
            gasUsed += callData[index] == 0 ? 4 : 16;
        }
    }

    /// @notice Makes a call as a caller, with every slot cold, and returns the gas the contract itself spent on it.
    function _executionGas(IERC20 token, address caller, bytes memory callData) internal returns (uint256) {
        vm.cool(address(token));
        vm.prank(caller);
        (bool succeeded,) = address(token).call(callData);
        assertTrue(succeeded);
        return vm.lastFrameGas().gasTotalUsed - TRANSACTION_BASE_COST - _callDataGas(callData);
    }

    /// @notice Sending to an address that holds nothing costs 17100 more than sending to one that holds something.
    function test_SendingToAFreshAddressCostsMoreThanSendingToAHolder() public {
        IERC20[2] memory tokens = [bareToken, openZeppelinToken];
        for (uint256 index = 0; index < tokens.length; index++) {
            uint256 toFresh = _executionGas(tokens[index], alice, abi.encodeCall(IERC20.transfer, (carol, 100)));
            uint256 toHolder = _executionGas(tokens[index], alice, abi.encodeCall(IERC20.transfer, (bob, 100)));

            assertEq(toFresh - toHolder, FIRST_WRITE_EXTRA_COST);
        }
    }

    /// @notice The first approval for a spender costs 17100 more than changing an existing one.
    function test_FirstApprovalCostsMoreThanChangingAnApproval() public {
        IERC20[2] memory tokens = [bareToken, openZeppelinToken];
        for (uint256 index = 0; index < tokens.length; index++) {
            uint256 first = _executionGas(tokens[index], alice, abi.encodeCall(IERC20.approve, (dave, 50)));
            uint256 change = _executionGas(tokens[index], alice, abi.encodeCall(IERC20.approve, (dave, 70)));

            assertEq(first - change, FIRST_WRITE_EXTRA_COST);
        }
    }

    /// @notice The bare token writes the allowance on every spend, even a maximum one, so both spends cost the same.
    function test_BareTokenSpendsAMaximumAllowanceLikeAnyOther() public {
        uint256 finite = _executionGas(bareToken, finiteSpender, abi.encodeCall(IERC20.transferFrom, (alice, bob, 10)));
        uint256 unlimited =
            _executionGas(bareToken, unlimitedSpender, abi.encodeCall(IERC20.transferFrom, (alice, bob, 10)));

        assertEq(finite, unlimited);
    }

    /// @notice OpenZeppelin skips the allowance write for a maximum allowance, which saves about the cost of that write.
    function test_OpenZeppelinSavesTheAllowanceWriteForAMaximumAllowance() public {
        uint256 finite =
            _executionGas(openZeppelinToken, finiteSpender, abi.encodeCall(IERC20.transferFrom, (alice, bob, 10)));
        uint256 unlimited =
            _executionGas(openZeppelinToken, unlimitedSpender, abi.encodeCall(IERC20.transferFrom, (alice, bob, 10)));

        assertGe(finite - unlimited, ALLOWANCE_WRITE_COST);
        assertLt(finite - unlimited, ALLOWANCE_WRITE_COST + 700);
    }

    /// @notice The standard's extra checks cost very little: the OpenZeppelin token is within 400 gas of the bare one.
    /// @dev Run with -vv to read the table of costs that the learning note quotes.
    function test_OpenZeppelinCostsAboutTheSameAsTheBareToken() public {
        bytes[5] memory calls = [
            abi.encodeCall(IERC20.transfer, (carol, 100)),
            abi.encodeCall(IERC20.transfer, (bob, 100)),
            abi.encodeCall(IERC20.approve, (dave, 50)),
            abi.encodeCall(IERC20.approve, (dave, 70)),
            abi.encodeCall(IERC20.transferFrom, (alice, bob, 10))
        ];
        string[5] memory names = [
            "transfer to a fresh address",
            "transfer to a holder",
            "first approval",
            "change an approval",
            "spend a finite allowance"
        ];
        console.log("scenario, bare token, openzeppelin token (gas the contract itself spent)");
        for (uint256 index = 0; index < calls.length; index++) {
            address caller = index == 4 ? finiteSpender : alice;
            uint256 bareCost = _executionGas(bareToken, caller, calls[index]);
            uint256 openZeppelinCost = _executionGas(openZeppelinToken, caller, calls[index]);
            console.log(names[index], bareCost, openZeppelinCost);

            assertLt(openZeppelinCost > bareCost ? openZeppelinCost - bareCost : bareCost - openZeppelinCost, 400);
        }
    }
}
