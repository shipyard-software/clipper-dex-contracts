// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// Allows for setting custom decimals, useful for testing
contract MockToken is ERC20, Ownable {
    uint8 immutable private _decimals;

    constructor(
        string memory name,
        string memory symbol,
        uint8 theDecimals
    ) ERC20(name, symbol) {
        _decimals = theDecimals;
    }

    function decimals() public view override(ERC20) returns (uint8) {
        return _decimals;
    }

    function mint(address account, uint256 amount) external onlyOwner {
        _mint(account, amount);
    }

    function burn(address account, uint256 amount) external onlyOwner {
        _burn(account, amount);
    }
}
