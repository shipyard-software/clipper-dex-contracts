// SPDX-License-Identifier: Business Source License 1.1 see LICENSE.txt
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";

import "./libraries/PLPAPIInterface.sol";
import "./libraries/UniERC20.sol";

// Simple router
contract ClipperRouter is Ownable {
    using UniERC20 for ERC20;
    
    address payable public clipperPool;
    PLPAPIInterface public clipperExchange;
    bytes auxiliaryData;

    constructor(address payable poolAddress, address exchangeAddress, string memory theData) {
        clipperPool = poolAddress;
        clipperExchange = PLPAPIInterface(exchangeAddress);
        auxiliaryData = bytes(theData);
    }

    function modifyContractAddresses(address payable poolAddress, address exchangeAddress) external onlyOwner {
        require((poolAddress!=address(0)) && exchangeAddress!=address(0), "Clipper Router: Invalid contract addresses");
        clipperPool = poolAddress;
        clipperExchange = PLPAPIInterface(exchangeAddress);
    }

    // Executes the "transfer-then-swap" modality in a single transaction
    function clipperSwap(address inputToken, uint256 sellAmount, address outputToken, address recipient, uint256 minBuyAmount) external payable {
        ERC20 _input = ERC20(inputToken);
        ERC20 _output = ERC20(outputToken);
        require(_input.uniCheckAllowance(sellAmount, msg.sender, address(this)), "Clipper Router: Allowance check failed");
        require(recipient != address(0), "Clipper Router: Invalid recipient");
        _input.uniTransferFromSender(sellAmount, clipperPool);
        if(_input.isETH()){
            clipperExchange.sellEthForToken(outputToken, recipient, minBuyAmount, auxiliaryData);
        } else if(_output.isETH()){
            clipperExchange.sellTokenForEth(inputToken, payable(recipient), minBuyAmount, auxiliaryData);
        } else {
            clipperExchange.sellTokenForToken(inputToken, outputToken, recipient, minBuyAmount, auxiliaryData);
        }
    }
}