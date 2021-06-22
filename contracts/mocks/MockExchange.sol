// SPDX-License-Identifier: Business Source License 1.1 see LICENSE.txt
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";

import "../libraries/PLPAPIInterface.sol";
import "../libraries/UniERC20.sol";

contract MockExchange is PLPAPIInterface {
    using UniERC20 for ERC20;

    event SwapOut(
        address outAsset,
        address recipient,
        uint256 outAmount,
        bytes auxiliaryData
    );

    MockPool public clipperPool;

    constructor() {
        clipperPool = new MockPool();
    }

    function getSellQuote(address inputToken, address outputToken, uint256 sellAmount) override external view returns (uint256 outputTokenAmount){
        return uint256(0);
    }

    function _minSwap(address outputToken, address recipient, uint256 minBuyAmount, bytes calldata auxiliaryData) internal returns (uint256 boughtAmount) {
        boughtAmount = clipperPool.makeTransfer(outputToken, recipient, minBuyAmount);
        emit SwapOut(outputToken, recipient, minBuyAmount, auxiliaryData);
    }

    function sellTokenForToken(address inputToken, address outputToken, address recipient, uint256 minBuyAmount, bytes calldata auxiliaryData) override external returns (uint256 boughtAmount){
        boughtAmount = _minSwap(outputToken, recipient, minBuyAmount, auxiliaryData);
    }

    function sellEthForToken(address outputToken, address recipient, uint256 minBuyAmount, bytes calldata auxiliaryData) override external payable returns (uint256 boughtAmount){
        boughtAmount = _minSwap(outputToken, recipient, minBuyAmount, auxiliaryData);
    }

    function sellTokenForEth(address inputToken, address payable recipient, uint256 minBuyAmount, bytes calldata auxiliaryData) override external returns (uint256 boughtAmount){
        boughtAmount = _minSwap(address(0), recipient, minBuyAmount, auxiliaryData);
    }
}

contract MockPool is Ownable {
    using UniERC20 for ERC20;

    function makeTransfer(address outputToken, address recipient, uint256 amount) external onlyOwner returns (uint256) {
        ERC20(outputToken).uniTransfer(recipient, amount);
        return amount;
    }

    receive() external payable {
    }

}