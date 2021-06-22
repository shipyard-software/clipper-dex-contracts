// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";

import "@chainlink/contracts/src/v0.6/interfaces/AggregatorV3Interface.sol";

contract MockOracle is Ownable, AggregatorV3Interface {
    
    int256 latestAnswer;
    string public override description;
    uint8 public override decimals;
    uint256 public override version;
    uint256 _timestamp;
    uint80 _theRound;

    constructor(int256 initialAnswer, uint8 theDecimals){
        latestAnswer = initialAnswer;
        decimals = theDecimals;
        description = "Mock Oracle";
        version = 1;
    }

    function updateAnswer(int256 newValue) external onlyOwner {
        latestAnswer = newValue;
    }

    function setUpdateTime(uint256 timestamp) external onlyOwner {
        _timestamp = timestamp;
    }

    function setRound(uint80 theRound) external onlyOwner {
        _theRound = theRound;
    }

    function latestRoundData() override external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) {
        uint256 returnedTimestamp;
        uint80 currentRound;
        if(_timestamp==0){
            returnedTimestamp = uint256(block.timestamp);
        } else {
            returnedTimestamp = _timestamp;
        }
        if(_theRound==0){
            currentRound = uint80(1);
        } else {
            currentRound = _theRound;
        }
        return (currentRound, latestAnswer, returnedTimestamp, returnedTimestamp, uint80(1));
    }

    function getRoundData(uint80 _roundId) override external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) {
        return (_roundId, latestAnswer, uint256(block.timestamp), uint256(block.timestamp), _roundId);
    }

}
