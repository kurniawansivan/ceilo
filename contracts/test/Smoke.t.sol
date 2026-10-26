// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice Proves the pinned compiler, forge-std and OpenZeppelin remapping resolve; remove in M3.
contract SmokeTest is Test {
    /// @notice Checks the IERC165 interface identifier, which only compiles if the remapping works.
    function test_ToolchainResolvesDependencies() public pure {
        assertEq(type(IERC165).interfaceId, bytes4(0x01ffc9a7));
    }
}
