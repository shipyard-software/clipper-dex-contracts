// SPDX-License-Identifier: Business Source License 1.1 see LICENSE.txt
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "../libraries/DepositInterface.sol";
import "../libraries/UniERC20.sol";

contract MockDeposit is DepositInterface {
    using UniERC20 for ERC20;

    struct Deposit {
        uint lockedUntil;
        uint256 poolTokenAmount;
    }

    MockPool public clipperPool;
    mapping(address => Deposit) public deposits;

    constructor(address poolOwner) {
        clipperPool = new MockPool(poolOwner);
    }

    function deposit(uint nDays) external override returns(uint256 newTokensToMint){
        // Add on to existing deposit, if it exists
        newTokensToMint = 100;
        Deposit storage curDeposit = deposits[msg.sender];
        uint lockDepositUntil = block.timestamp + (nDays*86400);
        Deposit memory myDeposit = Deposit({
                                    lockedUntil: curDeposit.lockedUntil > lockDepositUntil ? curDeposit.lockedUntil : lockDepositUntil,
                                    poolTokenAmount: newTokensToMint+curDeposit.poolTokenAmount
                                });
        deposits[msg.sender] = myDeposit;
    }

    function hasDeposit(address theAddress) internal view returns (bool) {
        return deposits[theAddress].lockedUntil > 0;
    }

    function canUnlockDeposit(address theAddress) public view returns (bool) {
        Deposit storage myDeposit = deposits[theAddress];
        return hasDeposit(theAddress) && (myDeposit.poolTokenAmount > 0) && (myDeposit.lockedUntil <= block.timestamp);
    }

    function unlockVestedDeposit() public override returns (uint256 numTokens) {
        require(canUnlockDeposit(msg.sender), "Deposit cannot be unlocked");
        numTokens = deposits[msg.sender].poolTokenAmount;
        delete deposits[msg.sender];
        clipperPool.recordUnlockedDeposit(msg.sender, numTokens);
    }
}

contract MockPool is ERC20, Ownable, PoolInterface {
    using UniERC20 for ERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    EnumerableSet.AddressSet private assetSet;

    address private depositAddress;

    constructor(address theOwner) ERC20("Pool Token", "POOL") {
        depositAddress = msg.sender;
        transferOwnership(theOwner);
    }


    receive() external payable {
    }

    function recordUnlockedDeposit(address account, uint256 numTokens) public {
        assert(msg.sender==depositAddress);
        _mint(account, numTokens);
    }

    function addToken(ERC20 newToken) public onlyOwner {
        assetSet.add(address(newToken));
    }

    function nTokens() public view override returns (uint) {
        return assetSet.length();
    }

    function tokenAt(uint i) public view override returns (address) {
        return assetSet.at(i);
    } 

}