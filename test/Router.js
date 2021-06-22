// We import Chai to use its asserting functions here.
const { expect } = require("chai");

const { waffle } = require("hardhat");
const { deployContract } = waffle;

// Constants.
const BigN = ethers.BigNumber;
const One = BigN.from(1e9).mul(1e9); // 1e18.
const eth = ethers.constants.AddressZero;

// Taken from https://stackoverflow.com/a/152573
// This is test-only method used as a way to get clearer understanding on
// hardhat objects, due to either sparse documentation or not great Google
// results yet.
function getMethods(obj) {
  var result = [];
  for (var id in obj) {
    try {
      if (typeof(obj[id]) == "function") {
        result.push(id);
        // Prints out the function definition in addition to 'id'. Commented
        // out because some objects have very large codebases.
        // result.push(id + ": " + obj[id].toString());
      }
    } catch (err) {
      result.push(id + ": inaccessible");
    }
  }
  return result;
}

// Converts big number to a recognizable number with decimals.
function strBign(n /*BigNumber*/, d /*int, decimals*/) {
  if (!d) { console.trace(); throw "Need a valid decimals, got: " + d; }
  var s = n.toString();
  const l = s.length
  if (l < d) {
    var remaining = d - l;
    while (remaining > 0) {
      s = "0" + s;
      remaining--;
    }
    return "0." + s;
  }
  return s.substring(0, l-d) + "." + s.substring(l-d);
}

// Taken from https://stackoverflow.com/a/39914235
// Usage: await sleep(5000);
// Should only be used as a quick hack to simulate await functionality.
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to return the address of an object, since we use it so often.
function A(o) {
  if (!o.address) { return o; }
  return o.address;
}

// Gets person's balance of token.
async function getbal(token, person) {
  if (token === eth) { // Assume ETH.
    return strBign(await web3.eth.getBalance(A(person)), 18);
  }
  let decimals = await token.decimals();
  return strBign(await token.balanceOf(A(person)), decimals);
}

// Returns variables that are useful to compare between state changes.
async function getState(R = {
  user: null,
  pool: null,
  tokens: [] /*ERC20[]*/,
}) {
  let S = {};

  // Owner's balance of each token.
  S.userBal = [];
  for (let t of R.tokens) {
    if (t === eth) {
      S.userBal.push(BigN.from(await web3.eth.getBalance(A(R.user))));
    } else { S.userBal.push(await t.balanceOf(A(R.user))); }
  }

  // Pool's balance of each token.
  S.poolBal = [];
  for (let t of R.tokens) {
    if (t === eth) {
      S.poolBal.push(BigN.from(await web3.eth.getBalance(R.pool)));
    } else { S.poolBal.push(await t.balanceOf(R.pool)); }
  }

  return S;
}

// Returns the eth used during the transaction.
async function getEthUsed(trans) {
  if (!trans.wait) { trans = await trans; }
  const receipt = await trans.wait();
  // console.log('gasUsed ' + U.strBign(receipt.gasUsed, 18));
  // console.log('gasPrice ' + trans.gasPrice);
  // console.log('gasPrice ' + U.strBign(trans.gasPrice, 18))
  return receipt.gasUsed.mul(trans.gasPrice);
}

async function basicSwapTest(R = {
  xchg: null,
  router: null,
  user: null,
  i: null, // input token.
  o: null, // output token.
  n_i: null, // Amount of input token to send.
  n_o: null, // Amount of output token to receive.
  approve: null, // bool whether to approve token swap.
  recipient: null, // default to user.
  exception_expected: null,
}) {
  const pool = await R.router.clipperPool() + '';
  R.pool = pool;
  R.tokens = [R.i, R.o];
  const s0 = await getState(R);
  const recipient = R.recipient || R.user;

  //---------------------------------------------------------------------------
  // Swap.
  //---------------------------------------------------------------------------
  let eth0 = BigN.from(0);
  if (R.i !== eth && R.approve) {
    const approve = R.i.approve(A(R.router), R.n_i);
    eth0 = await getEthUsed(approve);
  }

  let swap;
  if (R.i !== eth) {
    swap = R.router.clipperSwap(A(R.i), R.n_i, A(R.o), A(recipient), R.n_o);
  } else {
    swap = R.router.clipperSwap(A(R.i), R.n_i, A(R.o), A(recipient), R.n_o,
      {value: R.n_i}); // ETH is attached to call.
  }

  // Test exception is hit.
  if (R.exception_expected) {
    expect(swap).to.be.revertedWith(R.exception_expected);
    try { await swap; } catch(ex) {}
    return;
  }

  // Test swap works.
  expect(swap).to.emit(R.xchg, 'SwapOut');
  const eth1 = await getEthUsed(swap);

  //---------------------------------------------------------------------------
  // Asserts.
  //---------------------------------------------------------------------------
  const s1 = await getState(R);
  const ethUsed = eth0.add(eth1);

  // Assert owner's input token decreased by exactly R.n_i.
  let diff_i = s1.userBal[0].sub(s0.userBal[0]);
  if (R.i === eth) { diff_i = diff_i.add(ethUsed); }
  expect(diff_i).to.equal(R.n_i.mul(-1));

  // Assert owner's output token increased by exactly R.n_o.
  let diff_o = s1.userBal[1].sub(s0.userBal[1]);
  if (R.o === eth) { diff_o = diff_o.add(ethUsed); }
  expect(diff_o).to.equal(R.n_o);

  // Assert Pool balance of input token increased by exactly R.n_i.
  const pool_i = s1.poolBal[0].sub(s0.poolBal[0]);
  expect(pool_i).to.equal(R.n_i);

  // Assert Pool balance of output token decreased by exactly R.n_o.
  const pool_o = s1.poolBal[1].sub(s0.poolBal[1]);
  expect(pool_o).to.equal(R.n_o.mul(-1));
}

describe("Router Core Functionality Tests", function () {
  let router, pool, xchg;
  let rep, zrx; // ERC20 Tokens.
  let owner, addr1, addr2; // Signers.
  let routerABI;

  beforeEach(async function () {
    [owner, addr1, addr2, ...addrs] = await ethers.getSigners();

    // Create Exchange.
    let xchgContract = await ethers.getContractFactory("MockExchange");
    xchg = await xchgContract.deploy();
    await xchg.deployTransaction.wait();

    // Create Pool.
    let poolABI = await ethers.getContractFactory("contracts/mocks/MockExchange.sol:MockPool");
    let poolAddr = (await xchg.clipperPool()).toString();
    pool = new ethers.Contract(poolAddr, poolABI.interface, owner);

    // Create Router.
    routerABI = await ethers.getContractFactory("ClipperRouter");
    router = await routerABI.deploy(A(pool), A(xchg), "Clipper Router");
    await router.deployTransaction.wait();

    // Create REP.
    let erc20 = await ethers.getContractFactory("ERC20Mock");
    rep = await erc20.deploy('REP', 'REP', A(owner), One.mul(1000));
    await rep.deployTransaction.wait();

    // Create ZRX.
    zrx = await erc20.deploy('0x', 'ZRX', A(owner), One.mul(1000));
    await zrx.deployTransaction.wait();

    // Send REP, ZRX, ETH.
    await rep.transfer(A(pool), One.mul(10));
    await zrx.transfer(A(pool), One.mul(10));
    await owner.sendTransaction({ to: A(pool), value: One.mul(10) });

    // // Print pool balances.
    // console.log('======== pool balances ========');
    // console.log('rep ' + await getbal(rep, pool));
    // console.log('zrx ' + await getbal(zrx, pool));
    // console.log('eth ' + await getbal(eth, pool));
    // console.log('-------------------------------');

  });

  it('Must call approve before moving the inputToken', async function() {
    // Attempts to call clipperSwap without getting prior approval to move the
    // inputToken fail.
    await basicSwapTest({
      xchg, router, user: owner, i: rep, o: zrx, n_i: One, n_o: One,
      approve: false,
      exception_expected: 'Clipper Router: Allowance check failed'
    });
  });

  it('Attempts to call clipperSwap with a zero-address recipient fail',
    async function() {
      await basicSwapTest({
        xchg, router, user: owner, i: rep, o: zrx, n_i: One, n_o: One,
        approve: true, recipient: ethers.constants.AddressZero,
        exception_expected: 'Clipper Router: Invalid recipient'
      }); 
    }
  );

  it('token for token', async function() {
    // REP => ZRX
    await basicSwapTest({
      xchg, router, user: owner, i: rep, o: zrx, n_i: One, n_o: One,
      approve: true,
    });
  });

  it('token for eth', async function() {
    // REP => ETH.
    await basicSwapTest({
      xchg, router, user: owner, i: rep, o: eth, n_i: One.mul(123),
      n_o: One.div(2), approve: true,
    });
  });

  it('eth for token', async function() {
    // ETH => ZRX
    await basicSwapTest({
      xchg, router, user: owner, i: eth, o: zrx, n_i: One.div(2),
      n_o: One.mul(8), approve: true,
    });
  });

  it('only owner can call modifyContractAddresses', async function() {
    // Assert owner can modify.
    await router.modifyContractAddresses(A(pool), A(xchg));

    // Assert addr1 cannot call.
    const addr1router = new ethers.Contract(A(router), routerABI.interface, addr1);
    const t = addr1router.modifyContractAddresses(A(pool), A(xchg));
    expect(t).to.be.revertedWith('Ownable: caller is not the owner');
    try { await t; } catch(_ex) {};
  });
});
