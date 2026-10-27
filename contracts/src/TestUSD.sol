// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice A stablecoin stand-in for tests and testnets, with six decimals like USDC, minted only by its owner.
/// @dev Worth nothing, on purpose. It exists so the agent wallet has a token to pay with before any real one is used.
contract TestUSD is ERC20, Ownable {
    uint8 private constant DECIMALS = 6;

    /// @notice Creates the token with no supply and gives the owner the right to mint.
    constructor(address initialOwner) ERC20("Ceilo Test USD", "tUSD") Ownable(initialOwner) {}

    /// @notice Creates new tokens for an address; only the owner may.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Counts in six decimals, so one token is 1,000,000 units.
    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }
}
