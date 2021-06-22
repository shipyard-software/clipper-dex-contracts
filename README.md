# Clipper DEX Smart Contract Code

## Bug Bounty
Clipper hosts a bug bounty on Immunefi at the address https://www.immunefi.com/bounty/clipper.

If you have found a vulnerability in our project, it must be submitted through Immunefi's platform. Immunefi will handle bug bounty communications. Please see the bounty page at Immunefi for more details on accepted vulnerabilities, payout amounts, and rules of participation. Users who violate the rules of participation will not receive bug bounty payouts and may be temporarily suspended or banned from the bug bounty program.


## Clipper Core Exchange Contract Descriptions
* **ClipperRouter**: A stateless implementation of the "Deposit, then Swap" interaction modality (see below).
* **ClipperPool**: Core vault contract that holds pool assets.
* **ClipperExchangeInterface**: Automated market making logic.
* **ClipperDeposit**: Time-locked deposit contract.
* **BlacklistAndTimeFilter**: Implements logic to deny swaps or deposits. By default, prevents deposits from or swaps to OFAC-listed ETH wallets.

All the Solidity code is written for version 0.8, hence the limited use of the standard OpenZeppelin `SafeMath` libraries.

## Interaction Modalities

We use the "Deposit, then Register" modality of several current-generation DEXs. Under this design, the **Pool**, **ExchangeInterface**, and **Deposit** contracts never activate a transfer *from* a user. Rather:
* Our **Pool** contract keeps a snapshot of asset balances at the last time they were synced.
* Users start by transferring assets to the **Pool**.
* The contracts discover what the user did based on differences between current values and snapshotted values.
* After an interaction, the contracts take another snapshot, through a call to `_sync`.

**NB: Users risk the loss of their input funds if the asset transfer and sync happen in different transactions.** The provided **Router** contract implements swapping logic in a single transaction and is recommended for transactions with the exchange.

### Deposit
To deposit, transfer tokens or ETH to the **Pool** contract, and then call `deposit` on the **Deposit** contract. The **CollectionContract** provides a demonstration of the deposit interaction logic. **NB: At initial deployment, deposit functionality is not open to the public.** If you send tokens to the Clipper pool with the intent to deposit them, your funds will be lost without any recourse.

### Swap
To perform a swap, transfer tokens or ETH to the **Pool** contract, and then call the appropriate API function on the **ExchangeInterface** contract (or **Pool** contract, which just forwards to the **ExchangeInterface** contract). The **Router** contract provides a demonstration of the swap logic.

### Withdraw
To withdraw, start by unlocking the deposit with `unlockVestedDeposit` on the **Deposit** contract (this is not necessary when making an on-demand deposit). Then either call `withdraw` or `withdrawInto` on the **ExchangeInterface** contract.
* `withdraw` pulls out your *pro rata* share of every token in the pool.
* `withdrawInto` proposes a swap from the pool token to *one of* the assets in the pool. The automated market maker will accept that swap if it does not decrease its invariant.

## License
In general, the code in this repository is released under the Business Source License 1.1. This license has two periods: a restricted period, in which the code is not under an open-source license, followed by an open-source period, under which the code will be licensed under the GPLv2. The change date between the two licenses is July 4, 2023. Please see *LICENSE.txt* for additional information.

Certain auxiliary Solidity source files are taken verbatim or with trivial modification from files released under different licensing. We have preserved that original licensing where appropriate.

## Development

### Getting Started

`npm install --save-dev hardhat`

### Checking Contract Size

`npx hardhat compile; npx hardhat size-contracts`

### Test

A limited test suite of key exchange functionality is included.

`npx hardhat test`
