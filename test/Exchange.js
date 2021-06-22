// LICENSE: Business Source License 1.1 see LICENSE.txt
const { expect } = require("chai");

const { waffle } = require("hardhat");
const { deployContract } = waffle;

const U = require("./util");

describe("Exchange Function Test", function () {
  let Pool;
  let myPool;
  let otherPool;
  let myExchange;
  let otherExchange;
  let myDepositContract;
  let Deposit;
  let rep;
  let repOracle;
  let usdc;
  let usdcOracle;
  let owner;
  let eth;
  const OneGwei = ethers.utils.parseUnits("1","gwei")

  // `beforeEach` will run before each test, re-deploying the contract every
  // time. It receives a callback, which can be async.
  beforeEach(async function () {
    Pool = await ethers.getContractFactory("ClipperPool");
    Deposit = await ethers.getContractFactory("ClipperDeposit");
    let Exchange = await ethers.getContractFactory("ClipperExchangeInterface");
    let Approval = await ethers.getContractFactory("BlacklistAndTimeFilter");
    [owner, addr1, addr2, ...addrs] = await ethers.getSigners();
    eth = ethers.constants.AddressZero;

    myFilter = await Approval.deploy();
    await myFilter.deployTransaction.wait();

    myExchange = await Exchange.deploy(myFilter.address, 20);
    await myExchange.deployTransaction.wait();

    // Creates and deploys an instance of ClipperPool. This is going
    // to be used throughout the unit tests.
    myPool = await Pool.deploy(myExchange.address, {'value': U.One})
    await myPool.deployTransaction.wait();

    let poolset = await myExchange.setPoolAddress(myPool.address);
    await poolset.wait();

    myDepositAddress = await myPool.depositContract();
    myDepositContract = new ethers.Contract(myDepositAddress, Deposit.interface, owner);

    await myFilter.setPoolAddress(myPool.address);
  });

  describe("Admin Functions", function () {
    it("Can modify swap fee", async function() {
      expect(await myExchange.swapFee()).to.not.equal(1);
      await myExchange.modifySwapFee(1);
      expect(await myExchange.swapFee()).to.equal(1);
    });

    it("Cannot modify swap fee too high", async function() {
      let d = myExchange.modifySwapFee(501);
      expect(d).to.be.revertedWith('Clipper: Maximum swap fee exceeded');
      try { await d; } catch(ex) {}
    });

    it("Can modifyDepositContract", async function() {
      expect(await myPool.depositContract()).to.not.equal(eth);
      await myPool.modifyDepositContract(eth);
      expect(await myPool.depositContract()).to.equal(eth);
    });

    it("Can modifyExchangeInterfaceContract", async function() {
      expect(await myPool.exchangeInterfaceContract()).to.not.equal(eth);
      await myPool.modifyExchangeInterfaceContract(eth);
      expect(await myPool.exchangeInterfaceContract()).to.equal(eth);
    });

    it("Can mint coins", async function() {
      const bal0 = await myPool.balanceOf(U.addr(addr1));
      await myPool.mint(U.addr(addr1), 100);
      const bal1 = await myPool.balanceOf(U.addr(addr1));
      expect(bal1.sub(bal0)).to.equal(100);

      // Assert we can only mint every 5 days.
      // Try minting a 2nd time, immediately.
      let m = myPool.mint(U.addr(addr1), 100);
      expect(m).to.be.revertedWith('Clipper: Pool token can mint once in 5 days');
      try { await m; } catch(ex) {}

      // Try minting in 2 days.
      await U.timeTravel(172800 /*2days in seconds*/);
      m = myPool.mint(U.addr(addr1), 100);
      expect(m).to.be.revertedWith('Clipper: Pool token can mint once in 5 days');
      try { await m; } catch(ex) {}

      // Assert can mint after 5 days has passed.
      await U.timeTravel(259200 /*3days in seconds*/);
      await myPool.mint(U.addr(addr1), 100);

      // Assert cannot mint 5% or more of the pool.
      await U.timeTravel(432001 /*5days in seconds*/);
      let d0 = await myPool.fullyDilutedSupply();
      let max = d0.div(20); // 5%.
      m = myPool.mint(U.addr(addr1), max);
      expect(m).to.be.revertedWith('Clipper: Mint amount exceeded');
      try { await m; } catch(ex) {}

      // Assert can mint exactly at the limit 5% of the pool.
      await myPool.mint(U.addr(addr1), max.sub(1));
    });
  });

  describe("Deployment", function () {
    it("Can deploy", async function () {
      expect(await myPool.owner()).to.equal(owner.address);
    });

    it("Starts with correct invariant", async function () {
      expect(await myExchange.invariant()).to.equal(U.One);
    });

    it("Owner can modify ETH oracle, but not others", async function () {
      let oracleFactory = await ethers.getContractFactory("MockOracle");
      
      ethOracle = await oracleFactory.deploy(200000000, 8);
      await ethOracle.deployTransaction.wait();

      await expect(myPool.modifyEthOracle(ethOracle.address)).to.emit(myPool, 'TokenModified');

      expect(await myPool.ethOracle()).to.equal(ethOracle.address);
      expect(await myExchange.invariant()).to.be.closeTo(U.One.mul(2),1e6);

      await myPool.modifyEthOracle(ethers.constants.AddressZero);
      expect(await myExchange.invariant()).to.equal(U.One);
      expect(await myPool.ethOracle()).to.equal(ethers.constants.AddressZero);

      let otherPool = myPool.connect(addr1);
      await expect(otherPool.modifyEthOracle(ethOracle.address)).to.be.reverted;
    });

  });

  describe("Quote and Escape and Token Removal", function () {
    let ownerRep;
    let myEscapeContract;

    beforeEach(async function () {
      let tokenFactory = await ethers.getContractFactory("MockToken");
      let oracleFactory = await ethers.getContractFactory("MockOracle");

      rep = await tokenFactory.deploy("REP", "Augur REP", 18 /*decimals*/);
      await rep.deployTransaction.wait();
      repOracle = await oracleFactory.deploy(U.One.div(50), 18);
      await repOracle.deployTransaction.wait();

      await rep.mint(owner.address, U.One.mul(4747));

      ownerRep = rep.connect(owner);
      await ownerRep.deployTransaction.wait();

      let Escape = await ethers.getContractFactory("ClipperEscapeContract");
      myEscapeContract = new ethers.Contract(
        myPool.escapeContract(), Escape.interface, owner);
    });

    it("test large sell quote returns less than balance", async function() {
      await myPool.upsertAsset(rep.address, repOracle.address, 250);
      await ownerRep.transfer(U.addr(myPool), U.One.mul(3));
      await myDepositContract.deposit(0);

      let repq = await myExchange.getSellQuote(eth, U.addr(rep), U.One.mul(1000));
      let repbal = await myPool.lastBalance(U.addr(rep));

      // console.log('quote ' + repq);
      // console.log('repbal ' + repbal);
      expect(repbal.gte(repq));

      let ethq = await myExchange.getSellQuote(U.addr(rep), eth, U.One.mul(1000));
      let ethbal = await myPool.lastBalance(eth);

      // console.log('quote ' + ethq);
      // console.log('ethbal ' + ethbal);
      expect(ethbal.gte(ethq));
    });

    it("Can escape REP", async function () {
      await ownerRep.transfer(U.addr(myPool), U.One);
      await myPool.escape(U.addr(rep));
      let escRep = await rep.balanceOf(await myPool.escapeContract());
      expect(escRep).to.equal(U.One);
    });

    it("Can escape REP and ETH after removing asset", async function () {
      // 1. Add REP asset
      // 2. Starts removal
      // 3. Completes removal
      // Whole bunch of asserts all over the place.

      // Assert cannot remove a asset that is not in the pool.
      let incorrectRemove = myPool.removeToken(U.addr(rep));
      expect(incorrectRemove).to.be.revertedWith('Asset not present');
      try { await incorrectRemove; } catch(ex) {}

      await myPool.upsertAsset(rep.address, repOracle.address, 200);
      await ownerRep.transfer(U.addr(myPool), U.One);

      // Assert cannot escape tradeable asset.
      let incorrectEsc = myPool.escape(U.addr(rep));
      expect(incorrectEsc).to.be.revertedWith('Can only escape nontradable');
      try { await incorrectEsc; } catch(ex) {}

      await myPool.activateRemoval(U.addr(rep));
      await U.timeTravel(172800 /*2days in seconds*/);

      // Assert cannot remove token, b/c time lock is 5 days.
      let incorrectRemove2 = myPool.removeToken(U.addr(rep));
      expect(incorrectRemove2).to.be.revertedWith('Not ready');
      try { await incorrectRemove2; } catch(ex) {}

      // Assert asset still not tradable after 2 days, b/c time lock is 5 days.
      let incorrectEsc2 = myPool.escape(U.addr(rep));
      expect(incorrectEsc2).to.be.revertedWith('Can only escape nontradable');
      try { await incorrectEsc2; } catch(ex) {}

      // Assert cannot escape ETH.
      let incorrectEsc3 = myPool.escape(ethers.constants.AddressZero);
      expect(incorrectEsc3).to.be.revertedWith('Can only escape nontradable');
      try { await incorrectEsc3; } catch(ex) {}

      await U.timeTravel(259200 /*3days in seconds*/);

      // This remove should succeed! Time lock over.
      await myPool.removeToken(U.addr(rep));

      // This escape should succeed! Time lock over.
      await myPool.escape(U.addr(rep));

      // Escape should have the REP now.
      let escRep = await rep.balanceOf(await myPool.escapeContract());
      expect(escRep).to.equal(U.One);

      // Should be able to escape ETH.
      let { depositPromise, receiptone, transone } = await U.deposit({
        pool: myPool, owner, nDays: 0, num_eth: U.One,
        depositContract: myDepositContract });
      let d0 = await myPool.lastBalance(eth);
      await myPool.escape(eth);
      let d1 = await web3.eth.getBalance(await myEscapeContract.address);
      expect(d0).to.equal(d1);

      // Assert: Once assets are in the escape contract, the Clipper Pool owner
      // should be able to transfer them to whatever account they wish.
      let Escape = await ethers.getContractFactory("ClipperEscapeContract");
      let otherEscapeContract = new ethers.Contract(
        myPool.escapeContract(), Escape.interface, addr1);

      // Assert cannot transfer using addr1.
      let t = otherEscapeContract.transfer(U.addr(rep), U.addr(addr2), U.One); // REP
      expect(t).to.be.revertedWith('Only Clipper Owner');
      try { await t; } catch(ex) {}

      t = otherEscapeContract.transfer(eth, U.addr(addr1), U.One); // ETH
      expect(t).to.be.revertedWith('Only Clipper Owner');
      try { await t; } catch(ex) {}

      // Assert: can transfer rep from escape contract.
      await myEscapeContract.transfer(U.addr(rep), U.addr(addr2), U.One);
      let addr2rep = await rep.balanceOf(U.addr(addr2));
      expect(addr2rep).to.equal(U.One);

      // Assert: can transfer eth from escape contract.
      let eth1 = await addr1.getBalance();
      await myEscapeContract.transfer(eth, U.addr(addr1), U.One.mul(2));
      let eth2 = await addr1.getBalance();
      expect(eth2.sub(eth1)).to.equal(U.One.mul(2));
    });

    it("Can clearRemoval", async function () {
      // 1. Add asset
      // 2. start removal.
      // 3. stop removal.
      // 4. Assert token is no longer removed after 6 days.
      await myPool.upsertAsset(rep.address, repOracle.address, 200);
      await ownerRep.transfer(U.addr(myPool), U.One);
      await myPool.activateRemoval(U.addr(rep));
      await U.timeTravel(172800 /*2days in seconds*/);
      await myPool.clearRemoval(U.addr(rep));
      await U.timeTravel(345600 /*4days in seconds*/);

      // Assert removeToken is no longer possible b/c of clearRemoval.
      let remove = myPool.removeToken(U.addr(rep));
      expect(remove).to.be.revertedWith('Not ready');
      try { await remove; } catch(ex) {}
    });

    it("Can clearRemoval from triage", async function () {
      // 1. Make 'addr1' traige.
      // 2. Add REP to pool
      // 3. start removal.
      // 4. stop removal from triage.
      // 5. Assert token can no longer be removed after 6 days.

      // So now addr1 will be the triage account.
      await myPool.modifyTriage(U.addr(addr1));

      // Add REP to pool and start removal.
      await myPool.upsertAsset(rep.address, repOracle.address, 200);
      await ownerRep.transfer(U.addr(myPool), U.One);
      await myPool.activateRemoval(U.addr(rep));
      await U.timeTravel(172800 /*2days in seconds*/);

      // Use clearRemoval, but from triage instead of owner.
      otherExchange = myExchange.connect(addr1);
      await otherExchange.deployTransaction.wait();
      otherPool = new ethers.Contract(otherExchange.theExchange(), Pool.interface, addr1);
      await otherPool.clearRemoval(U.addr(rep));

      // Assert removeToken is no longer possible b/c of clearRemoval.
      await U.timeTravel(345600 /*4days in seconds*/);
      let remove = myPool.removeToken(U.addr(rep));
      expect(remove).to.be.revertedWith('Not ready');
      try { await remove; } catch(ex) {}
    });
  });

  async function depositETHaloneTest() {
    let x = await owner.getBalance();
    let { depositPromise, receiptone, transone } = await U.deposit({
        pool: myPool, owner, nDays: 0, num_eth: U.One,
        depositContract: myDepositContract });
    let pone = transone.gasPrice;

    // We expect UnlockedDeposit event to be fired in the pool "very soon"
    // (within 5 seconds), because we passed "nDays = 0" to deposit, which
    // contractually means we should get newly minted coins immediately.
    // If "nDays >= 1", then it would take n days.
    expect(depositPromise).to.emit(myPool, 'UnlockedDeposit');

    let trans = await depositPromise;
    let receipt = await trans.wait();
    let price = trans.gasPrice;
    let y = await owner.getBalance();

    let spentOnTransaction = receipt.gasUsed.mul(price).add(receiptone.gasUsed.mul(pone));
    let newInv = await myExchange.invariant();
    let newDiluted = await myPool.fullyDilutedSupply();

    expect(U.bigToNum(x.sub(y).sub(spentOnTransaction))).to.equal(1e6);
    // Will not add precisely to 2 because of sqrt rounding

    expect(newInv.div(U.One.div(1e6)).toNumber()).to.be.closeTo(2e6,1);
    expect(newDiluted.div(U.One.div(1e6)).toNumber()).to.be.closeTo(2e7,10);
  }

  // Unit test:
  // 1. deposit for 1 day.
  // 2. attempt to unlock deposit immediately. Attempt early withdraw.
  // 3. expect transaction to fail b/c deposit requested too early.
  // 4. fast forward block 24 hours.
  // 5. attempt to unlock deposit
  // 6. expect success, since the necessary time has passed.
  // 7. attempt to withdraw. Should succeed.
  //
  // Returns the state of the unit test, so that further unit tests can do
  // more asserts on variables here.
  //
  // `A` is just named dict of args.
  //
  // Variable explanations:
  // + inv0 is invariant at the very beginning, before deposit.
  // + inv1 is invariant after deposit, before unlock.
  // + inv2 is invariant after unlock.
  async function depositETH1dayTest(A = {
    // Amount of tokens to withdraw.
    withdrawAmount: U.One,

    //-------------------------------------------------------------------------
    // Expected numbers.
    //-------------------------------------------------------------------------
    // These are the numbers to expect for a pool that has only ETH and a
    // deposit of 1 ETH.

    // Amount the invariant increased due to deposit.
    depositInvInc: 1e6,

    // Amount the ETH balance has increased due to unlock.
    unlockETHbalInc: 2e7,

    // Amount the total supply has increased due to unlock.
    unlockSupplyInc: 1e7,

    // Amount of ETH given by pool. Note that this does NOT include the gas
    // used to make transaction, which means ETH balance post-withdraw could
    // still be less than pre-withdraw!
    //
    // This number is calculated from: (1-fee) * withdrawAmount, where fee is
    // 0.002 and withdrawAmount is 1e18.
    withdrawEthInc: "99800000000000000",
  }) {
    const S = {}; // State of unit test, to be returned at end of function.

    //-----------------------------------------------------------------------
    // Asserts.
    //-----------------------------------------------------------------------
    // invariant/diluted at the very beginning of unit test.
    let inv0 = await myExchange.invariant();
    let diluted0 = await myPool.fullyDilutedSupply();
    let supply0 = await myPool.totalSupply();
    let poolEth0 = await owner.provider.getBalance(myPool.address);
    //console.log("Before deposit, pool has ETH ",poolEth0.toString());
    //console.log("Before deposit, invariant is ",inv0.toString());


    // Assert that the depositor address does NOT exist in the deposits
    // mapping. Since no deposits have been made...
    let depositEntry = await myDepositContract.deposits(owner.address);
    expect(depositEntry.lockedUntil.toNumber()).to.equal(0);
    expect(depositEntry.poolTokenAmount.toNumber()).to.equal(0);

    //-----------------------------------------------------------------------
    // EVENT: deposit for 1 day.
    //-----------------------------------------------------------------------
    let { depositPromise, receiptone, transone } = await U.deposit({
        pool: myPool, owner, nDays: 1, num_eth: U.One,
        depositContract: myDepositContract });
    let trans = await depositPromise;
    let receipt = await trans.wait();

    //-----------------------------------------------------------------------
    // Asserts.
    //-----------------------------------------------------------------------

    // Assert that the depositor address exists in the deposits mapping.
    // Because the owner *did* deposit.
    depositEntry = await myDepositContract.deposits(owner.address);
    expect(depositEntry.lockedUntil.div(1e6).toNumber()).to.not.equal(0);

    // Assert locked duration of deposit is around a day.
    const lockedDuration = depositEntry.lockedUntil.toNumber() -
      (await U.nowSecs());
    expect(lockedDuration).to.equal(86400 /*secs in day*/);

    // At the end of this unit test, the invariant of the exchange should be
    // the same as this inv1.
    let inv1 = await myExchange.invariant();
    let diluted1 = await myPool.fullyDilutedSupply();
    let supply1 = await myPool.totalSupply();
    let poolEth1 = await owner.provider.getBalance(myPool.address);
    //console.log("After deposit, pool has ETH ",poolEth1.toString());
    //console.log("After deposit, invariant is ",inv1.toString());

    // Assert that the total supply did not change after deposit, because
    // total supply should only change on unlock, NOT on deposit.
    expect(supply1.sub(supply0).toNumber()).to.equal(0);

    // Assert that
    // fullyDilutedSupply(after) / fullyDilutedSupply(before) =
    //   invariant(after) / invariant(before)
    let dilutedRatio = diluted1.mul(1e8).div(diluted0);
    let invRatio = inv1.mul(1e8).div(inv0);
    expect(invRatio).to.equal(dilutedRatio);

    // Assert that the invariant after deposit has increased by One (1e18).
    const invInc = U.bigToNum(inv1.sub(inv0));
    expect(invInc).to.be.closeTo(A.depositInvInc, 1);

    // Assert that the pool token amount is equal to the increase in the
    // invariant function due to the deposit.
    expect(U.bigToNum(depositEntry.poolTokenAmount)).to.be.closeTo(10*invInc, 10);

    // We expect unlock transaction to be reverted because we initiated
    // deposit for 1 day.
    let earlyUnlock = myDepositContract.unlockVestedDeposit()
    expect(earlyUnlock).to.be.revertedWith('Deposit cannot be unlocked');

    // Must wrap await earlyUnlock in a error handler, as we expect it to
    // throw exception due to unlocking too early.
    try { await earlyUnlock; } catch(ex) {}

    // Assert that withdrawing too small amount will revert.
    const earlyWithdraw = myExchange.withdraw(100);
    expect(earlyWithdraw).to.be.revertedWith('Not enough to withdraw');
    try { await earlyWithdraw; } catch(ex) {}

    //-----------------------------------------------------------------------
    // EVENT: time travel forward 1 day, then unlock.
    //-----------------------------------------------------------------------
    await U.timeTravel(86400 /*secs in day*/);

    // Now that time has fast forwarded past 1 day, this unlock should
    // succeed.
    let correctUnlock = myDepositContract.unlockVestedDeposit()
    expect(correctUnlock).to.emit(myPool, 'UnlockedDeposit');
    await correctUnlock;

    //-----------------------------------------------------------------------
    // Asserts.
    //-----------------------------------------------------------------------

    // Assert that the owner has received tokens in the pool.
    const bal0 = await myPool.balanceOf(owner.address)
    expect(U.bigToNum(bal0)).to.be.closeTo(A.unlockETHbalInc, 1);

    // Assert that the depositor address should be removed from the deposits
    // mapping.
    depositEntry = await myDepositContract.deposits(owner.address);
    expect(depositEntry.lockedUntil.toNumber()).to.equal(0);
    expect(depositEntry.poolTokenAmount.toNumber()).to.equal(0);

    // Assert that the invariant has not changed.
    let inv2 = await myExchange.invariant();
    expect(inv2).to.equal(inv1);

    // Assert that the total supply has increased due to the unlock.
    let supply2 = await myPool.totalSupply();
    expect(U.bigToNum(supply2.sub(supply1))).to.be.closeTo(A.unlockSupplyInc, 1);

    // Assert withdrawing too large amount will revert.
    const lotsaMoney = ethers.BigNumber.from(2).mul(1e15).mul(1e15).mul(1e15);
    const overdraw = myExchange.withdraw(lotsaMoney);
    expect(overdraw).to.be.reverted;
    try { await overdraw; } catch(ex) {}

    //-----------------------------------------------------------------------
    // EVENT: withdraw.
    //-----------------------------------------------------------------------
    const eth0 = await owner.getBalance();
    S.withdrawAmount = A.withdrawAmount;
    const correctWithdraw = myExchange.withdraw(S.withdrawAmount);

    //-----------------------------------------------------------------------
    // Asserts.
    //-----------------------------------------------------------------------
    let t1 /*transaction*/ = await correctWithdraw;
    let receipt1 = await t1.wait();
    let ethUsed1 = receipt1.gasUsed.mul(t1.gasPrice);
    const eth1 = await owner.getBalance();

    // Assert owner's got exactly the withdrawn ETH expected.
    expect(eth1.sub(eth0).add(ethUsed1)).to.equal(
      ethers.BigNumber.from(A.withdrawEthInc));

    let diluted2 = await myPool.fullyDilutedSupply();
    let supply3 = await myPool.totalSupply();
    const bal1 = await myPool.balanceOf(owner.address)
    let inv3 = await myExchange.invariant();

    let poolEth2 = await owner.provider.getBalance(myPool.address);
    //console.log("After withdrawal, pool has ETH ",poolEth2.toString());
    //console.log("After withdrawal, invariant is ",inv3.toString());

    // Assert that the fullyDilutedSupply, totalSupply, balance is reduced
    // exactly by the amount withdrawn.
    expect(diluted1.sub(diluted2)).to.equal(S.withdrawAmount);
    expect(supply2.sub(supply3)).to.equal(S.withdrawAmount);
    expect(bal0.sub(bal1)).to.equal(S.withdrawAmount);

    // Invariant should increase slightly proportional to pool supply
    // (inv2 - inv3) / inv2 <= fraction of pre-withdrawal invariant taken
    // (supply2-supply3) /supply2 <= fraction of pre-withdrawal invariant taken
    // Invariant should increase
    //console.log("Invariant before and after withdraw: ",inv2.toString(),inv3.toString());
    let invariantFractionTaken = inv2.sub(inv3).mul(1e8).div(inv2).toNumber();
    //console.log("Invariant fraction taken: ",invariantFractionTaken);
    //console.log("Pool token before and after withdraw: ",supply2.toString(),supply3.toString());
    let poolTokenFractionTaken = supply2.sub(supply3).mul(1e8).div(supply2).toNumber();
    //console.log("Pool token fraction taken: ",poolTokenFractionTaken);
    // poolTokenFractionTaken >= invariantFractionTaken
    expect(invariantFractionTaken).to.be.at.most(poolTokenFractionTaken);
    // invariantFractionRemaining ~= poolTokenFractionRemaining by fee, modulo some rounding
    const poolFee = 0.002;
    expect(invariantFractionTaken).to.be.closeTo(poolTokenFractionTaken, poolFee*poolTokenFractionTaken+2);

    return S; // State.
  }

  describe("ETH alone operations", function () {
    it("Can deposit ETH alone correctly", depositETHaloneTest);
    it("Can deposit ETH for 1 day correctly", depositETH1dayTest);
  });

  describe("Swap, Withdraw", function () {
    let beforeInvariant;
    let otherRep;
    let otherDepositContract;
    let otherUSDC;

    beforeEach(async function () {
      let tokenFactory = await ethers.getContractFactory("MockToken");
      let oracleFactory = await ethers.getContractFactory("MockOracle");

      rep = await tokenFactory.deploy("REP", "Augur REP", 18);
      await rep.deployTransaction.wait();
      repOracle = await oracleFactory.deploy(U.One.div(50), 18);
      await repOracle.deployTransaction.wait();

      await rep.mint(addr1.address, U.One.mul(9000));
      otherExchange = myExchange.connect(addr1);
      await otherExchange.deployTransaction.wait();

      otherPool = new ethers.Contract(otherExchange.theExchange(), Pool.interface, addr1);
      otherDepositContract = new ethers.Contract(otherPool.depositContract(), Deposit.interface, addr1);

      otherRep = rep.connect(addr1);
      await otherRep.deployTransaction.wait();

      usdc = await tokenFactory.deploy("USDC", "USDC Token", 6);
      await usdc.deployTransaction.wait();
      usdcOracle = await oracleFactory.deploy(Math.floor(1e8 / 600), 8);
      await usdcOracle.deployTransaction.wait();
      await usdc.mint(addr1.address, U.One);

      otherUSDC = usdc.connect(addr1);

      beforeInvariant = await myExchange.invariant();
      await myPool.upsertAsset(rep.address, repOracle.address, 100);
    });

    function transfer(token, from, addr, n_i) {
      let tokenContract = null;
      if (token === eth) { return from.sendTransaction({ to: addr, value: n_i }); }
      if (token === rep) { return otherRep.transfer(addr, n_i); }
      if (token === usdc) { return otherUSDC.transfer(addr, n_i); }
      throw 'transfer(): unknown token ' + token;
    }

    async function withdrawIntoTest(A = {
      pool: null,
      xchg: null,
      owner: null,
      token: null /*ERC20*/,
      W: null /*withdrawAmount: BigNum*/,
      O: null /*outputAmount: BigNum*/,
    }) {
      A.tokens = [ A.token ];
      const s0 = await U.getState(A);

      //-----------------------------------------------------------------------
      // EVENT: withdrawInto USDC
      //-----------------------------------------------------------------------
      let ethUsed;
      if (A.token === eth) { // ETH special case.
        let t1 = await A.xchg.withdrawInto(A.W, eth, A.O);
        let receipt = await t1.wait();
        ethUsed = receipt.gasUsed.mul(t1.gasPrice);
      } else {
        await A.xchg.withdrawInto(A.W, A.token.address, A.O);
      }

      //-----------------------------------------------------------------------
      // Asserts.
      //-----------------------------------------------------------------------
      const s1 = await U.getState(A);

      // Assert totalSupply, fullyDilutedSupply, balance has decreased by
      // exactly withdrawAmount.
      expect(s1.supply.sub(s0.supply)).to.equal(A.W.mul(-1));
      expect(s1.diluted.sub(s0.diluted)).to.equal(A.W.mul(-1));
      expect(s1.bal.sub(s0.bal)).to.equal(A.W.mul(-1));

      // Assert owner got exactly amount requested.
      oInc = s1.tokens[0].sub(s0.tokens[0]);
      if (A.token === eth) { oInc = oInc.add(ethUsed); }
      expect(oInc).to.equal(A.O);

      // Assert invariant condition maintained.
      // (invBefore - invAfter)  / (invBefore) <= tokenAmountBurned / fullyDilutedSupplyBefore
      let LH = s0.inv.sub(s1.inv).mul(1e15).div(s0.inv);
      let RH = A.W.mul(1e15).div(s0.diluted);
      expect(U.bigToNum(LH)).to.be.at.most(U.bigToNum(RH));
    }

    function withdrawIntoArg() {
      return {
        pool: myPool,
        xchg: myExchange,
        owner: owner,
        W /*withdrawAmount*/: ethers.BigNumber.from("100000000000000000" /*1e18*/),
        O /*outputTokenAmount*/: ethers.BigNumber.from(1e10),
      };
    }

    async function withdrawIntoRepTest(rep) {
      const A = withdrawIntoArg();
      A.token = rep;
      await withdrawIntoTest(A);
    }

    async function withdrawIntoUsdcTest(usdc) {
      const A = withdrawIntoArg();
      A.token = usdc;
      A.O = A.O.div(1e6);
      await withdrawIntoTest(A);
    }

    async function withdrawIntoEthTest() {
      const A = withdrawIntoArg();
      A.token = eth; // ETH token.
      await withdrawIntoTest(A);
    }

    async function ethForRepTest(ifc, transfer) {
      await otherRep.transfer(myPool.address, U.One.mul(50));
      await otherDepositContract.deposit(0);
      await U.basicSwapTest({ pool: myPool, xchg: myExchange, owner: addr1,
        i: eth, o: rep, transfer, attach: true, ifc});
    }

    async function swapRepForUsdcTest(ifc) {
      // Setup USDC in the pool.
      await myPool.upsertAsset(usdc.address, usdcOracle.address, 100);

      // Deposit USDC and REP.
      await otherUSDC.transfer(myPool.address, U.One.div(100));
      await otherRep.transfer(myPool.address, U.One.mul(50));
      await otherDepositContract.deposit(0);

      await U.basicSwapTest({ pool: myPool, xchg: myExchange, owner: addr1,
        i: rep, o: usdc, transfer, n_i: U.One.div(100), ifc });
    }

    async function assertRevert(code, exStr) {
      let ex = null;
      try { await code(); } catch(_ex) { ex = _ex; }
      expect(ex.toString().indexOf(exStr)).to.be.at.least(0);
    }

    async function minBuySwapTest(i, o) {
      await assertRevert(async function() {
        await U.basicSwapTest({ pool: myPool, xchg: myExchange, owner: addr1,
          i: i, o: o, transfer, minBuyAmount: U.One.mul(33),
          ifc: otherExchange  });
      }, "revert Clipper: Not enough output");
    }

    async function ofacSwapTest(i, o) {
      await assertRevert(async function() {
        await U.basicSwapTest({ pool: myPool, xchg: myExchange, owner: addr1,
          i: i, o: o, transfer, attach: true, ifc: otherExchange,
          ofac: '0xA7e5d5A720f06526557c513402f2e6B5fA20b008' });
      }, "revert Clipper: Recipient not approved");
    }

    async function testBlockAddr(filter) {
      // Test blockAddress.
      await filter.blockAddress(U.addr(addr1));
      await assertRevert(async function() {
        await U.basicSwapTest({ pool: myPool, xchg: myExchange, owner: addr1,
          i: rep, o: eth,

          // Please note this is false, to prevent "two" transfers by the time
          // the 2nd U.basicSwapTest runs and throws off that test.
          transfer: false,

          ifc: otherExchange 
        });
      }, 'Clipper: Recipient not approved');

      // Test unblockAddress.
      await filter.unblockAddress(U.addr(addr1));
      await U.basicSwapTest({ pool: myPool, xchg: myExchange, owner: addr1,
        i: rep, o: eth, transfer, ifc: otherExchange });
    }

    async function testDenySwaps(filter) {
      // Test swaps are working before denySwaps.
      await U.basicSwapTest({ pool: myPool, xchg: myExchange, owner: addr1,
        i: rep, o: eth, transfer, ifc: otherExchange  });

      // Test denySwaps.
      await filter.denySwaps();
      await assertRevert(async function() {
        await U.basicSwapTest({ pool: myPool, xchg: myExchange, owner: addr1,
          i: rep, o: eth, ifc: otherExchange,

          // Please note this is false, to prevent "two" transfers by the time
          // the 2nd U.basicSwapTest runs and throws off that test.
          transfer: false });
      }, 'Clipper: Recipient not approved');

      // Test denySwaps is not callable by a random address.
      let Approval = await ethers.getContractFactory("BlacklistAndTimeFilter");
      let otherFilter = new ethers.Contract(filter.address, Approval.interface, addr1);
      let d = otherFilter.denySwaps();
      expect(d).to.be.revertedWith('Clipper: Only owner or triage');
      try { await d; } catch(ex) {}

      // Test denySwaps is callable by triage.
      await myPool.modifyTriage(U.addr(addr1));
      await otherFilter.denySwaps();

      // Test allowSwaps not callable by triage.
      d = otherFilter.allowSwaps();
      expect(d).to.be.revertedWith('Clipper: Only owner');
      try { await d; } catch(ex) {}

      // Test allowSwaps.
      await filter.allowSwaps();
      await U.basicSwapTest({ pool: myPool, xchg: myExchange, owner: addr1,
        i: rep, o: eth, transfer, ifc: otherExchange  });
    }

    it("Oracle updated more than 24 hours ago reverts, but fresh oracle works fine", async function() {
      // Unit test setup.
      await otherRep.transfer(otherPool.address, U.One.mul(10));
      await otherDepositContract.deposit(0);

      // Make Oracle stale.
      await repOracle.setUpdateTime((await U.nowSecs()) - 86400 - 20);

      // Assert deposit reverts due to stale oracle.
      await otherRep.transfer(otherPool.address, U.One.mul(10));
      let w = otherDepositContract.deposit(0);
      expect(w).to.be.revertedWith('Oracle out of date');
      try { await w; } catch(ex) {}

      // Assert swap reverts due to stale oracle.
      await assertRevert(async function() {
        await U.basicSwapTest({ pool: myPool, xchg: myExchange, owner: addr1,
          i: rep, o: eth, transfer, attach: true, ifc: otherExchange });
      }, 'Oracle out of date');

      // Reset Oracle to normal.
      await repOracle.setUpdateTime((await U.nowSecs()));

      // Assert deposits work now.
      await otherRep.transfer(otherPool.address, U.One.mul(10));
      await otherDepositContract.deposit(0);

      // Assert swaps work now.
      await U.basicSwapTest({ pool: myPool, xchg: myExchange, owner: addr1,
        i: rep, o: eth, transfer, attach: false, ifc: otherExchange  });
    });

    it("Oracle updated in a prior round will revert", async function() {
      // Unit test setup.
      await otherRep.transfer(otherPool.address, U.One.mul(10));
      await otherDepositContract.deposit(0);

      // Make Oracle stale.
      await repOracle.setRound(2);

      // Assert deposit reverts due to stale oracle.
      await otherRep.transfer(otherPool.address, U.One.mul(10));
      let w = otherDepositContract.deposit(0);
      expect(w).to.be.revertedWith('Oracle out of date');
      try { await w; } catch(ex) {}

      // Assert swap reverts due to stale oracle.
      await assertRevert(async function() {
        await U.basicSwapTest({ pool: myPool, xchg: myExchange, owner: addr1,
          i: rep, o: eth, transfer, attach: true, ifc: otherExchange  });
      }, 'Oracle out of date');

      // Reset Oracle to normal.
      await repOracle.setRound(0);

      // Assert deposits work now.
      await otherRep.transfer(otherPool.address, U.One.mul(10));
      await otherDepositContract.deposit(0);

      // Assert swaps work now.
      await U.basicSwapTest({ pool: myPool, xchg: myExchange, owner: addr1,
        i: rep, o: eth, transfer, attach: false, ifc: otherExchange  });
    });

    it("Can set exclusive deposit address", async function() {
      await myFilter.setExclusiveDepositAddress(U.addr(addr1));

      // Assert addr1 can deposit.
      await otherRep.transfer(otherPool.address, U.One.mul(50));
      await otherDepositContract.deposit(0);

      // Assert owner cannot deposit.
      let { depositPromise } = await U.deposit({
        pool: myPool, owner, nDays: 0, num_eth: U.One,
        depositContract: myDepositContract });
      expect(depositPromise).to.be.revertedWith('Clipper: Deposit rejected');
      try { await depositPromise; } catch(ex) {}
    });

    it("Can ETH->REP with ETH attached and transferred, using otherPool",
      async function() { await ethForRepTest(otherPool, transfer); });

    it("Can ETH->REP after attaching ETH to call, using otherPool",
      async function() { await ethForRepTest(otherPool, false /*transfer*/); });

    it("Can swap from ETH after adding tokens, using otherPool", async function() {
      await U.basicSwapTest({ pool: myPool, xchg: myExchange, owner: addr1,
        i: rep, o: eth, transfer, ifc: otherPool });
    });

    it("Can swap between two tokens, using otherPool", async function() {
      await swapRepForUsdcTest(otherPool);
    });

    it("Can withdrawAll", async function() {
      // Note: this test is run with owner, since the owner started with 1 ETH,
      // set during the beforeEach at the very top.
      await U.deposit({ pool: myPool, owner, nDays: 0, num_eth: U.One,
        depositContract: myDepositContract });

      // Assert some rando can't withdrawAll.
      let w = otherExchange.withdrawAll();
      expect(w).to.be.reverted;
      try { await w; } catch(ex) {}

      // Assert owner can withdrawAll.
      let initialPoolEth = await myPool.lastBalance(eth);
      const eth1 = await owner.getBalance();
      const t = await await myExchange.withdrawAll();
      const r = await t.wait();
      const g = r.gasUsed.mul(t.gasPrice);
      const eth2 = await owner.getBalance();

      // Assert we got all the ETH in the pool, minus gas used.
      expect(eth2.sub(eth1).add(g)).to.equal(initialPoolEth);
      
      // Assert the pool has no ETH left
      let finalPoolEth = await myPool.lastBalance(eth);
      expect(finalPoolEth).to.equal(0);
    });

    it("Can blockAddress, unblockAddress", async function() {
      await testBlockAddr(myFilter);
    });

    it("Can denySwaps, allowSwaps", async function() {
      await testDenySwaps(myFilter);
    });

    it("Can switch filters", async function() {
      // Deploy new filter.
      let Approval = await ethers.getContractFactory("BlacklistAndTimeFilter");
      let newFilter = await Approval.deploy();
      await newFilter.deployTransaction.wait();
      await myExchange.modifyApprovalContract(newFilter.address);
      await newFilter.setPoolAddress(myPool.address);

      // Assert filter tests work with the new filter.
      await testBlockAddr(newFilter);
      await testDenySwaps(newFilter);

      // Assert old filter tests don't work with the old filter.
      await assertRevert(async function() { await testBlockAddr(myFilter); },
        'AssertionError: expected -1 to be at least 0');
      await assertRevert(async function() { await testDenySwaps(myFilter); },
        'AssertionError: expected -1 to be at least 0');
    });

    it("withdrawInto Failure Cases", async function() {
      // Test setup, add REP to pool.
      await otherRep.transfer(myPool.address, U.One.mul(50));
      await otherDepositContract.deposit(0 /*nDays*/);

      // Assert not possible to withdrawInto unsupported token.
      await assertRevert(async function() {
        await withdrawIntoUsdcTest(usdc);
      }, "Clipper: Unsupported withdrawal");

      // Add USDC.
      await myPool.upsertAsset(usdc.address, usdcOracle.address, 100);
      await otherUSDC.transfer(myPool.address, U.One.div(100));
      await otherDepositContract.deposit(0 /*nDays*/);

      // Assert pool tokens not mintable by non-owner.
      let weirdmint = otherPool.mint(U.addr(addr1), 1);
      expect(weirdmint).to.be.revertedWith('Ownable: caller is not the owner');
      try { await weirdmint; } catch(ex) {}

      // Assert asking for just a little too much pool token fails.
      const bal0 = await myPool.balanceOf(U.addr(addr1))
      let w = otherExchange.withdraw(bal0.add(1));
      expect(w).to.be.revertedWith('ERC20: burn amount exceeds balance');
      try { await w; } catch(ex) {}

      // Assert Calls to withdrawInto for more pool token than the account has
      // should fail.
      w = otherExchange.withdrawInto(bal0.add(1), U.addr(rep), 1);
      expect(w).to.be.revertedWith('ERC20: burn amount exceeds balance');
      try { await w; } catch(ex) {}

      // Assert Calls to withdrawInto for too much token should fail.
      let poolRep = await otherPool.lastBalance(U.addr(rep));
      w = otherExchange.withdrawInto(bal0, U.addr(rep), poolRep.add(1));
      expect(w).to.be.revertedWith('ERC20: transfer amount exceeds balance');
      try { await w; } catch(ex) {}

      // Assert asking for just the right amount of pool token works.
      await otherExchange.withdraw(bal0);
    });

    it("Cannot swap to OFAC blocked address", async function () {
      // Setup USDC in the pool.
      await myPool.upsertAsset(usdc.address, usdcOracle.address, 100);

      // Deposit USDC and REP.
      await otherUSDC.transfer(myPool.address, U.One.div(100));
      await otherRep.transfer(myPool.address, U.One.mul(50));
      await otherDepositContract.deposit(0);

      await ofacSwapTest(rep, usdc);
      await ofacSwapTest(eth, rep);
      await ofacSwapTest(rep, eth);
    });

    it("Cannot ETH->REP with too high min buy amount", async function () {
      await myPool.upsertAsset(usdc.address, usdcOracle.address, 100);
      await otherRep.transfer(myPool.address, U.One.mul(50));
      await otherUSDC.transfer(myPool.address, U.One.div(100));
      await otherDepositContract.deposit(0);

      // Asserts reverts because minBuyAmount too high.
      await minBuySwapTest(eth, rep);
      await minBuySwapTest(rep, eth);
      await minBuySwapTest(rep, usdc);
    });

    it("Can ETH->REP with ETH attached and transferred", async function () {
      await ethForRepTest(otherExchange, transfer);
    });

    it("Cannot REP->USDC if USDC not valid token", async function () {
      await assertRevert(async function() {
        await U.basicSwapTest({ pool: myPool, xchg: myExchange, owner: addr1,
          i: rep, o: usdc });
      }, "revert Clipper: Untradable asset(s)");
    });

    it("Cannot REP->ETH if nothing transferred", async function () {
      await otherRep.transfer(myPool.address, U.One.mul(50));
      await otherDepositContract.deposit(0);
      await assertRevert(async function() {
        await U.basicSwapTest({ pool: myPool, xchg: myExchange, owner: addr1,
          i: rep, o: eth, ifc: otherExchange  });
      }, "revert Clipper: Not enough output");
    });

    it("Can ETH->REP even if selling too much ETH", async function () {
      await otherRep.transfer(myPool.address, U.One.mul(2));
      await otherDepositContract.deposit(0);
      // Selling 5 ETH for 2 REP is an absurd trade. This should still work.
      await U.basicSwapTest({ pool: myPool, xchg: myExchange, owner: addr1,
        i: eth, o: rep, attach: true, n_i: U.One.mul(5), ifc: otherExchange  });
    });

    it("sellTokenForEth: Can trade REP into a pool with 0 REP", async function () {
      // Assert pool starts with 0 rep.
      let rep0 = await myPool.lastBalance(rep.address);
      expect(rep0).to.equal(0);

      // Assert it's possible to sell rep to the pool for eth.
      await U.basicSwapTest({ pool: myPool, xchg: myExchange, owner: addr1,
        i: rep, o: eth, transfer, ifc: otherExchange  });
    });

    it("Can ETH->REP after attaching ETH to call", async function () {
      await ethForRepTest(otherExchange, transfer); 
    });

    it("Can swap between two tokens", async function () {
      await swapRepForUsdcTest(otherExchange);
    });

    it("Can swap from ETH after adding tokens", async function () {
      await U.basicSwapTest({ pool: myPool, xchg: myExchange, owner: addr1,
        i: rep, o: eth, transfer, ifc: otherExchange  });
    });

    it("withdrawInto correctly from 3-token pool", async function() {
      //-----------------------------------------------------------------------
      // EVENT: unit test setup. Pool has 3 tokens, ETH, USDC and REP.
      //-----------------------------------------------------------------------
      await myPool.upsertAsset(usdc.address, usdcOracle.address, 100);
      await otherRep.transfer(myPool.address, U.One.mul(50));
      await otherUSDC.transfer(myPool.address, U.One.div(100));
      await otherDepositContract.deposit(0 /*nDays*/);

      await withdrawIntoRepTest(rep);
      await withdrawIntoEthTest();
      await withdrawIntoUsdcTest(usdc);
    });

    it("withdrawInto correctly from 2-token pool", async function() {
      //-----------------------------------------------------------------------
      // EVENT: unit test setup. Pool has two tokens, ETH and REP.
      //-----------------------------------------------------------------------
      const S /*state*/ = await depositETH1dayTest();
      await otherRep.transfer(myPool.address, U.One.mul(50));
      await otherDepositContract.deposit(0 /*nDays*/);

      await withdrawIntoRepTest(rep);
      await withdrawIntoEthTest();
    });

    it("cannot withdrawInto more eth than what's in pool", async function() {
      //-----------------------------------------------------------------------
      // EVENT: unit test setup. Pool has two tokens, ETH and REP.
      //-----------------------------------------------------------------------
      await otherRep.transfer(myPool.address, U.One.mul(100));
      await otherDepositContract.deposit(0 /*nDays*/);

      let poolEth0 = await myPool.lastBalance(eth);
      const bal0 = await myPool.balanceOf(U.addr(addr1))
      const eth0 = await addr1.getBalance();

      // Assert cannot wipe out more than the pool's eth.
      w = otherExchange.withdrawInto(bal0, eth, poolEth0.add(1));
      expect(w).to.be.reverted;
      try { await w; } catch(ex) {}

      // Assert can take out 99.8% of the pool's eth. This must be possible,
      // since the fee is 0.2%, so this must be possible.
      const eth1 = await addr1.getBalance();
      const t = await otherExchange.withdrawInto(bal0, eth, poolEth0);
      const r = await t.wait();
      const g = r.gasUsed.mul(t.gasPrice);
      const eth2 = await addr1.getBalance();

      // Assert we got the withdraw eth amount requested, minus gas used.
      expect(eth2.sub(eth1).add(g)).to.equal(poolEth0);
    });

    it("deposit ETH alone for 1 day correctly in 3-token pool that has both ETH and REP", async function() {
      await myPool.upsertAsset(usdc.address, usdcOracle.address, 100);
      await otherRep.transfer(myPool.address, U.One.mul(50));
      await otherUSDC.transfer(myPool.address, U.One.div(100));
      await otherDepositContract.deposit(0 /*nDays*/);
      const S /*state*/ = await depositETH1dayTest({
        // TODO: doc how we arrived at these numbers.
        depositInvInc:   3383861237,
        unlockETHbalInc: 33848612375,
        unlockSupplyInc: 33838612375,
        withdrawEthInc: "11776400000",
        withdrawAmount: ethers.BigNumber.from(1).mul(1e15).mul(1e3),
      });
    });

    it("deposit ETH alone for 1 day correctly in 2-token pool that has both ETH and REP", async function() {
      await otherRep.transfer(myPool.address, U.One.mul(50));
      await otherDepositContract.deposit(0 /*nDays*/);
      const S /*state*/ = await depositETH1dayTest({
        // TODO: doc how we arrived at these numbers.
        depositInvInc: 1828427,
        unlockETHbalInc: 28284271,
        unlockSupplyInc: 18284271,
        withdrawEthInc: "34245945850000000",
        withdrawAmount: ethers.BigNumber.from(1).mul(1e15).mul(1e3),
      });
    });

    it("Can add demonstration token", async function () {
      expect(await myPool.getOracle(rep.address)).to.equal(repOracle.address);
      expect(await myPool.nTokens()).to.equal(1);
    });

    it("Can modify demonstration token", async function () {
      await myPool.upsertAsset(rep.address, repOracle.address, 200)
      let myWeight = await myPool.getMarketShare(rep.address);
      expect(myWeight).to.equal(200);
      expect(await myPool.nTokens()).to.equal(1);
    });


    it("Has same invariant prior to adding demonstration tokens", async function () {
      let afterInvariant = await myExchange.invariant();
      await expect(afterInvariant).to.equal(beforeInvariant);
    });

    it("Has correct invariant after adding some demonstration tokens", async function () {
      await otherRep.transfer(myPool.address, U.One.mul(50));

      let tmpInvariant = await myExchange.invariant();
      expect(tmpInvariant).to.equal(beforeInvariant);

      await otherDepositContract.deposit(0);
      let afterInvariant = await otherExchange.invariant();
      // 50 REP = 1 ETH, so adding 50 rep doubles token base and then it gets squared
      await expect(afterInvariant).to.equal(beforeInvariant.mul(4));
    });

    it("Can add a second token", async function () {
      await myPool.upsertAsset(usdc.address, usdcOracle.address, 200);
      let reporacle = await myPool.getOracle(rep.address);
      expect(reporacle).to.equal(repOracle.address);
      let usdcoracle = await myPool.getOracle(usdc.address);
      expect(usdcoracle).to.equal(usdcOracle.address);
      let usdcweight = await myPool.getMarketShare(usdc.address);
      expect(usdcweight).to.equal(200);
      expect(await myPool.nTokens()).to.equal(2);
    });

    it("Can deposit ETH alone correctly into a pool with 2 tokens",
      depositETHaloneTest);
    it("Can deposit ETH alone for 1 day correctly into a pool with 2 tokens",
      depositETH1dayTest);

    // Other swaps

  });
});
