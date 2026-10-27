// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @notice An ERC-20 token written from EIP-20 alone, to learn what the standard fixes and what it leaves open.
contract BareToken {
    /// @notice Announces tokens moving from one address to another, and the new supply when it is created.
    event Transfer(address indexed from, address indexed to, uint256 value);

    /// @notice Announces that an owner set how much a spender may withdraw.
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// @notice The sender holds fewer tokens than it tries to move.
    error InsufficientBalance(address account, uint256 balance, uint256 needed);

    /// @notice The spender may withdraw fewer tokens than it tries to move.
    error InsufficientAllowance(address spender, uint256 allowance, uint256 needed);

    /// @notice The name of the token.
    string public name;

    /// @notice The short symbol of the token.
    string public symbol;

    /// @notice How many decimal places an interface should show; the token itself only counts whole units.
    uint8 public decimals;

    /// @notice How many token units exist, which never changes after the constructor.
    uint256 public totalSupply;

    /// @notice How many token units each address holds.
    mapping(address account => uint256 balance) public balanceOf;

    /// @notice How many token units a spender may still withdraw from an owner.
    mapping(address owner => mapping(address spender => uint256 remaining)) public allowance;

    /// @notice Creates the whole supply and gives it to the deployer.
    constructor(string memory tokenName, string memory tokenSymbol, uint8 tokenDecimals, uint256 initialSupply) {
        name = tokenName;
        symbol = tokenSymbol;
        decimals = tokenDecimals;
        totalSupply = initialSupply;
        balanceOf[msg.sender] = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }

    /// @notice Moves tokens from the caller to another address.
    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    /// @notice Lets a spender withdraw up to a value from the caller, replacing any earlier allowance.
    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    /// @notice Moves tokens from an owner to another address, spending the caller's allowance from that owner.
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 remaining = allowance[from][msg.sender];
        if (remaining < value) {
            revert InsufficientAllowance(msg.sender, remaining, value);
        }
        allowance[from][msg.sender] = remaining - value;
        _transfer(from, to, value);
        return true;
    }

    /// @notice Moves tokens between two addresses after checking that the sender holds enough.
    function _transfer(address from, address to, uint256 value) internal {
        uint256 balance = balanceOf[from];
        if (balance < value) {
            revert InsufficientBalance(from, balance, value);
        }
        balanceOf[from] = balance - value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
