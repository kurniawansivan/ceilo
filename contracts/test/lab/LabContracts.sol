// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @notice A contract with one function and a fallback, to show how calldata is matched to code.
contract DispatchLab {
    uint256 public fallbackCallCount;

    /// @notice Adds two numbers, with Solidity's overflow check.
    function add(uint256 first, uint256 second) external pure returns (uint256) {
        return first + second;
    }

    /// @notice Counts every call whose selector matches no function, and every call with no calldata.
    fallback() external {
        fallbackCallCount += 1;
    }
}

/// @notice A contract with one function and no fallback, so an unknown selector reverts.
contract StrictLab {
    /// @notice Adds two numbers, with Solidity's overflow check.
    function add(uint256 first, uint256 second) external pure returns (uint256) {
        return first + second;
    }
}

/// @notice Functions that write state and then revert, caught or not, to show what a revert undoes.
contract RollbackLab {
    error Boom(uint256 code);

    uint256 public value;
    bool public caught;

    /// @notice Writes one to the value and then reverts, so the write must not survive.
    function writeThenRevert() external {
        value = 1;
        revert Boom(7);
    }

    /// @notice Writes two, then catches a reverting call that wrote one, so only the inner write is undone.
    function writeThenCatch() external {
        value = 2;
        try this.writeThenRevert() {}
        catch {
            caught = true;
        }
    }

    /// @notice Writes three and then calls a function that reverts without catching it, so everything is undone.
    function writeThenCallRevertingFunction() external {
        value = 3;
        this.writeThenRevert();
    }

    /// @notice Writes five and returns normally.
    function writeOnly() external {
        value = 5;
    }
}

/// @notice Logic that records a value and who called it, to be reached by call, delegatecall and staticcall.
contract LogicLab {
    uint256 public value;
    address public lastCaller;

    /// @notice Stores a value and the address that called this function.
    function record(uint256 newValue) external {
        value = newValue;
        lastCaller = msg.sender;
    }

    /// @notice Reads the stored value without changing anything.
    function readOnly() external view returns (uint256) {
        return value;
    }
}

/// @notice Reaches LogicLab three ways; its storage layout matches LogicLab's, slot for slot.
contract CallerLab {
    uint256 public value;
    address public lastCaller;
    uint256 internal constant STATICCALL_GAS = 100_000;
    address internal immutable LOGIC;

    /// @notice Remembers which logic contract to reach.
    constructor(address logicAddress) {
        LOGIC = logicAddress;
    }

    /// @notice Runs the logic in the logic contract's own context.
    function viaCall(uint256 newValue) external {
        (bool succeeded,) = LOGIC.call(abi.encodeCall(LogicLab.record, (newValue)));
        require(succeeded, "call failed");
    }

    /// @notice Runs the logic's code against this contract's storage.
    function viaDelegatecall(uint256 newValue) external {
        (bool succeeded,) = LOGIC.delegatecall(abi.encodeCall(LogicLab.record, (newValue)));
        require(succeeded, "delegatecall failed");
    }

    /// @notice Tries to run the state-writing function in a context that forbids writes, and reports whether it ran.
    function viaStaticcall(uint256 newValue) external view returns (bool) {
        (bool succeeded,) = LOGIC.staticcall{gas: STATICCALL_GAS}(abi.encodeCall(LogicLab.record, (newValue)));
        return succeeded;
    }

    /// @notice Reads the logic contract's value through a staticcall.
    function readViaStaticcall() external view returns (uint256) {
        (bool succeeded, bytes memory returnedData) = LOGIC.staticcall(abi.encodeCall(LogicLab.readOnly, ()));
        require(succeeded, "staticcall failed");
        return abi.decode(returnedData, (uint256));
    }
}

/// @notice Delegatecalls LogicLab with a different storage layout, so the logic's writes land on the wrong variables.
contract MismatchedCallerLab {
    address public owner;
    uint256 public counter;
    address internal immutable LOGIC;

    /// @notice Remembers which logic contract to reach.
    constructor(address logicAddress) {
        LOGIC = logicAddress;
    }

    /// @notice Runs the logic's code against this contract's storage, whatever the layout there is.
    function viaDelegatecall(uint256 newValue) external {
        (bool succeeded,) = LOGIC.delegatecall(abi.encodeCall(LogicLab.record, (newValue)));
        require(succeeded, "delegatecall failed");
    }
}
