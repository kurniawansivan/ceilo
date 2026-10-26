// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice Toolchain smoke test: the pinned compiler, forge-std and the OpenZeppelin remapping all resolve.
/// @dev Remove once real tests exist (M3).
contract SmokeTest is Test {
    function test_ToolchainResolvesDependencies() public pure {
        assertEq(type(IERC165).interfaceId, bytes4(0x01ffc9a7));
    }
}
