// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test, stdError} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TestUSD} from "../../src/TestUSD.sol";

/// @notice Makes bounded calls to TestUSD for the fuzzer and checks each one against a reference model of the rules.
/// @dev Each action works out first what must happen, success or the exact revert data, then makes the call and compares.
contract TestUSDHandler is Test {
    uint256 internal constant MINT_SCALE = 1e24;
    uint256 internal constant SMALL_AMOUNT_RANGE = 1_000_000;

    /// @notice The token the handler calls.
    TestUSD public immutable TOKEN;
    /// @notice The address that owns the token and is the only one that may mint.
    address public immutable OWNER;

    /// @notice What each holder should have, according to the model.
    mapping(address holder => uint256 balance) public modelBalance;
    /// @notice What each spender should still be allowed to take from each holder, according to the model.
    mapping(address holder => mapping(address spender => uint256 remaining)) public modelAllowance;
    /// @notice The supply the model expects.
    uint256 public modelSupply;
    /// @notice How many calls ended differently from what the model said they would.
    uint256 public disagreements;
    /// @notice How many mints succeeded.
    uint256 public successfulMints;
    /// @notice How many transfers succeeded.
    uint256 public successfulTransfers;
    /// @notice How many transferFrom calls succeeded.
    uint256 public successfulSpends;
    /// @notice Whether the supply was ever seen to go down.
    bool public supplyDecreased;

    address[] internal actors;
    uint256 internal lastSeenSupply;

    /// @notice Remembers the token, its owner and the addresses that take part in the fuzzed calls.
    constructor(TestUSD token, address owner, address[] memory actorList) {
        TOKEN = token;
        OWNER = owner;
        actors = actorList;
    }

    /// @notice How many addresses take part.
    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    /// @notice The participating address at a position.
    function actorAt(uint256 index) external view returns (address) {
        return actors[index];
    }

    /// @notice The owner mints to a participant, an amount that may be too large for the supply to hold.
    function mint(uint256 recipientSeed, uint256 amountSeed) external {
        address recipient = _actor(recipientSeed);
        uint256 headroom = type(uint256).max - modelSupply;
        bool nearTheLimit = (amountSeed / 8) % 4 == 0;
        uint256 amount = _amount(amountSeed, nearTheLimit || headroom < MINT_SCALE ? headroom : MINT_SCALE);
        bytes memory expected;
        if (amount > headroom) {
            expected = stdError.arithmeticError;
        }

        if (_call(OWNER, abi.encodeCall(TestUSD.mint, (recipient, amount)), expected)) {
            modelBalance[recipient] += amount;
            modelSupply += amount;
            successfulMints++;
        }
        _afterAction();
    }

    /// @notice A participant who is not the owner tries to mint, which must always be refused.
    function mintAsSomeoneElse(uint256 callerSeed, uint256 amountSeed) external {
        address caller = _actor(callerSeed);
        bytes memory expected = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller);

        _call(caller, abi.encodeCall(TestUSD.mint, (caller, _amount(amountSeed, MINT_SCALE))), expected);
        _afterAction();
    }

    /// @notice A participant transfers to another, an amount that may be more than it holds.
    function transfer(uint256 senderSeed, uint256 recipientSeed, uint256 amountSeed) external {
        address sender = _actor(senderSeed);
        address recipient = _actor(recipientSeed);
        uint256 balance = modelBalance[sender];
        uint256 amount = _amount(amountSeed, balance);
        bytes memory expected;
        if (amount > balance) {
            expected = abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, sender, balance, amount);
        }

        if (_call(sender, abi.encodeCall(IERC20.transfer, (recipient, amount)), expected)) {
            modelBalance[sender] -= amount;
            modelBalance[recipient] += amount;
            successfulTransfers++;
        }
        _afterAction();
    }

    /// @notice A participant sets how much another may take from it, which replaces whatever was set before.
    function approve(uint256 holderSeed, uint256 spenderSeed, uint256 amountSeed) external {
        address holder = _actor(holderSeed);
        address spender = _actor(spenderSeed);
        uint256 amount = _amount(amountSeed, modelAllowance[holder][spender]);

        if (_call(holder, abi.encodeCall(IERC20.approve, (spender, amount)), "")) {
            modelAllowance[holder][spender] = amount;
        }
        _afterAction();
    }

    /// @notice A participant takes tokens from another within, or beyond, what it was allowed or what the holder has.
    function transferFrom(uint256 spenderSeed, uint256 holderSeed, uint256 recipientSeed, uint256 amountSeed) external {
        address spender = _actor(spenderSeed);
        address holder = _actor(holderSeed);
        address recipient = _actor(recipientSeed);
        uint256 allowed = modelAllowance[holder][spender];
        uint256 balance = modelBalance[holder];
        uint256 amount = _amount(amountSeed, (amountSeed / 8) % 2 == 0 ? allowed : balance);

        bytes memory expected = _expectedTransferFromFailure(spender, holder, amount);
        if (_call(spender, abi.encodeCall(IERC20.transferFrom, (holder, recipient, amount)), expected)) {
            if (allowed != type(uint256).max) {
                modelAllowance[holder][spender] = allowed - amount;
            }
            modelBalance[holder] -= amount;
            modelBalance[recipient] += amount;
            successfulSpends++;
        }
        _afterAction();
    }

    /// @notice The owner tries to mint to the zero address, which must always be refused.
    function mintToTheZeroAddress(uint256 amountSeed) external {
        bytes memory expected = abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0));

        _call(OWNER, abi.encodeCall(TestUSD.mint, (address(0), _amount(amountSeed, MINT_SCALE))), expected);
        _afterAction();
    }

    /// @notice A participant tries to send to the zero address, which must be refused whatever the amount.
    function transferToTheZeroAddress(uint256 senderSeed, uint256 amountSeed) external {
        address sender = _actor(senderSeed);
        bytes memory expected = abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0));

        _call(
            sender, abi.encodeCall(IERC20.transfer, (address(0), _amount(amountSeed, modelBalance[sender]))), expected
        );
        _afterAction();
    }

    /// @notice A participant tries to let the zero address spend its tokens, which must be refused.
    function approveTheZeroAddress(uint256 holderSeed, uint256 amountSeed) external {
        address holder = _actor(holderSeed);
        bytes memory expected = abi.encodeWithSelector(IERC20Errors.ERC20InvalidSpender.selector, address(0));

        _call(holder, abi.encodeCall(IERC20.approve, (address(0), _amount(amountSeed, MINT_SCALE))), expected);
        _afterAction();
    }

    /// @notice A participant tries to take tokens to the zero address, refused for the allowance first, else the receiver.
    function transferFromToTheZeroAddress(uint256 spenderSeed, uint256 holderSeed, uint256 amountSeed) external {
        address spender = _actor(spenderSeed);
        address holder = _actor(holderSeed);
        uint256 allowed = modelAllowance[holder][spender];
        uint256 amount = _amount(amountSeed, allowed);
        bytes memory expected = abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0));
        if (allowed != type(uint256).max && allowed < amount) {
            expected =
                abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, spender, allowed, amount);
        }

        _call(spender, abi.encodeCall(IERC20.transferFrom, (holder, address(0), amount)), expected);
        _afterAction();
    }

    /// @notice The revert data a transferFrom must give, or nothing when it must succeed; the allowance is checked first.
    function _expectedTransferFromFailure(address spender, address holder, uint256 amount)
        internal
        view
        returns (bytes memory)
    {
        uint256 allowed = modelAllowance[holder][spender];
        if (allowed != type(uint256).max && allowed < amount) {
            return abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, spender, allowed, amount);
        }
        uint256 balance = modelBalance[holder];
        if (amount > balance) {
            return abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, holder, balance, amount);
        }
        return "";
    }

    /// @notice Calls the token as a caller and counts a disagreement unless it ended as expected; true when it should have succeeded.
    function _call(address caller, bytes memory callData, bytes memory expectedFailure) internal returns (bool) {
        vm.prank(caller);
        (bool succeeded, bytes memory returnedData) = address(TOKEN).call(callData);

        bool expectedToSucceed = expectedFailure.length == 0;
        bool agrees =
            expectedToSucceed ? succeeded : !succeeded && keccak256(returnedData) == keccak256(expectedFailure);
        if (!agrees) {
            disagreements++;
        }
        return succeeded && expectedToSucceed;
    }

    /// @notice Notes whether the supply went down since the last action.
    function _afterAction() internal {
        uint256 supply = TOKEN.totalSupply();
        if (supply < lastSeenSupply) {
            supplyDecreased = true;
        }
        lastSeenSupply = supply;
    }

    /// @notice Picks a participant from a seed.
    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// @notice Picks an amount from a seed, favouring zero, the anchor and its neighbours, where mistakes hide.
    function _amount(uint256 seed, uint256 anchor) internal pure returns (uint256) {
        uint256 choice = seed % 8;
        uint256 random = uint256(keccak256(abi.encode(seed)));
        uint256 oneAbove = anchor == type(uint256).max ? anchor : anchor + 1;

        if (choice == 0) return 0;
        if (choice == 1) return anchor;
        if (choice == 2) return oneAbove;
        if (choice == 3) return anchor == 0 ? 0 : anchor - 1;
        if (choice == 4) return random % oneAbove;
        if (choice == 5) return random % SMALL_AMOUNT_RANGE;
        if (choice == 6) return anchor / 2;
        return type(uint256).max;
    }
}
